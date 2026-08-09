import {
  chatMembershipEvents,
  chatMessages,
  channelEvents,
  createChatAssignmentControl,
  rawIrcMessages,
  streamSessions,
  twitchUsers,
  type DbClient
} from "@twitch-tracker/db";
import { parseIrcLine, SocketIrcAdapter, type ParsedIrcMessage, type TwitchIrcAdapter } from "@twitch-tracker/twitch";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { resolvePrimaryBotCredentials } from "../bot-auth.js";
import type { WorkerContext } from "../worker.js";
import { startIntervalLoop } from "./common.js";

const staleJoiningTimeoutMs = 2 * 60 * 1000;

export const runIrcLoop = (context: WorkerContext) => {
  const assignments = createChatAssignmentControl(context.db);
  let adapter: TwitchIrcAdapter | null = null;
  let connected = false;
  let connectedBotAccountId: string | null = null;
  let connectedLogin: string | null = null;

  const completion = startIntervalLoop({
    name: "irc",
    intervalMs: context.config.ASSIGNMENT_INTERVAL_MS,
    context,
    run: async () => {
      if (!context.config.ENABLE_TWITCH_INGESTION) {
        return { activeConnections: 0, skipped: "ENABLE_TWITCH_INGESTION is false." };
      }

      const bot = await resolvePrimaryBotCredentials(context.db, context.config);
      if (bot.botAccountId == null || bot.login == null) {
        return { activeConnections: 0, skipped: "No enabled bot account is configured." };
      }

      const botAccountId = bot.botAccountId;
      const botLogin = bot.login;
      const botAccessToken = bot.accessToken;
      if (botAccessToken == null) {
        return { activeConnections: 0, skipped: "No valid bot access token is configured.", botLogin };
      }

      if (adapter != null && (connectedBotAccountId !== botAccountId || connectedLogin !== botLogin)) {
        await adapter.disconnect("bot_account_changed");
        adapter = null;
        connected = false;
        connectedBotAccountId = null;
        connectedLogin = null;
      }

      if (adapter == null || !connected) {
        adapter = new SocketIrcAdapter({
          login: botLogin,
          oauthToken: botAccessToken,
          events: {
            connected: () => {
              connected = true;
              connectedBotAccountId = botAccountId;
              connectedLogin = botLogin;
            },
            disconnected: async (reason) => {
              connected = false;
              adapter = null;
              connectedBotAccountId = null;
              connectedLogin = null;
              await assignments.record({
                type: "socket_disconnected",
                botAccountId,
                reason,
                observedAt: new Date()
              });
            },
            rawMessage: async (message) => {
              await persistRawIrcMessage(context.db, botAccountId, botLogin, message);
              if (message.command === "RECONNECT") {
                await adapter?.disconnect("twitch_reconnect");
              }
            },
            error: (error) => {
              console.error(JSON.stringify({ level: "error", loop: "irc", message: error.message }));
            }
          }
        });
        await adapter.connect();
      }

      const commandPlan = await assignments.planIrcCommands({
        botAccountId,
        capacity: bot.maxJoinedRooms,
        joinRatePer10Seconds: bot.joinRatePer10Seconds,
        staleJoiningTimeoutMs,
        observedAt: new Date()
      });

      let parted = 0;
      for (const assignment of commandPlan.leave) {
        if (assignment.channelLogin != null) {
          await adapter.part(assignment.channelLogin);
        }

        await assignments.record({
          type: "leave_processed",
          assignmentId: assignment.assignmentId,
          observedAt: new Date()
        });
        parted += 1;
      }

      let joined = 0;
      for (const assignment of commandPlan.join) {
        if (assignment.channelLogin == null) {
          continue;
        }

        await adapter.join(assignment.channelLogin);
        await assignments.record({
          type: "join_command_sent",
          assignmentId: assignment.assignmentId,
          observedAt: new Date()
        });
        joined += 1;
      }

      return {
        activeConnections: connected ? 1 : 0,
        joinCommandsSent: joined,
        partCommandsSent: parted,
        roomReservations: commandPlan.roomReservations,
        availableRoomSlots: commandPlan.availableRoomSlots,
        staleJoiningRequeued: commandPlan.staleJoiningRequeued,
        botLogin,
        botTokenSource: bot.source
      };
    }
  });

  return completion.then(async () => {
    if (adapter != null) {
      await adapter.disconnect("worker_shutdown");
    }
  });
};

const persistRawIrcMessage = async (db: DbClient, botAccountId: string, botLogin: string, message: ParsedIrcMessage) => {
  const channelLogin = getChannelLogin(message);
  const [raw] = await db
    .insert(rawIrcMessages)
    .values({
      rawLine: message.rawLine,
      parsedCommand: message.command,
      tags: message.tags,
      channelLogin,
      botAccountId,
      receivedAt: new Date(),
      processingStatus: "processed"
    })
    .returning({ id: rawIrcMessages.id });

  if (raw == null) {
    throw new Error("Failed to persist raw IRC message.");
  }

  if (message.command === "PRIVMSG") {
    await persistChatMessage(db, botAccountId, message, raw.id, channelLogin);
  }

  if (message.command === "JOIN" || message.command === "PART") {
    if (getUserLogin(message) === botLogin) {
      if (message.command === "PART") {
        await markAssignmentParted(db, botAccountId, channelLogin);
      }
    } else {
      await persistMembershipEvent(db, botAccountId, message, raw.id, channelLogin);
    }
  }

  if (message.command === "CLEARMSG") {
    await markDeletedChatMessage(db, message);
  }

  if (message.command === "CLEARCHAT") {
    await markClearedChatMessages(db, message, channelLogin);
  }

  if (message.command === "USERNOTICE") {
    await persistUserNoticeEvent(db, message, raw.id, channelLogin);
  }

  if (message.command === "NOTICE") {
    await persistNoticeEvent(db, botAccountId, message, raw.id, channelLogin);
  }

  if (
    message.command === "ROOMSTATE" ||
    message.command === "USERSTATE" ||
    (message.command === "JOIN" && getUserLogin(message) === botLogin)
  ) {
    await markAssignmentJoined(db, botAccountId, channelLogin);
  }
};

const persistChatMessage = async (
  db: DbClient,
  botAccountId: string,
  message: ParsedIrcMessage,
  rawIrcMessageId: string,
  channelLogin: string | null
) => {
  const broadcaster = await findUserByLogin(db, channelLogin);
  if (broadcaster == null) {
    return;
  }

  const chatterUserId = message.tags["user-id"];
  const chatterLogin = getUserLogin(message);
  if (chatterUserId != null) {
    await db
      .insert(twitchUsers)
      .values({
        twitchUserId: chatterUserId,
        login: chatterLogin,
        displayName: message.tags["display-name"] ?? chatterLogin,
        firstSeenAt: new Date(),
        lastSeenAt: new Date()
      })
      .onConflictDoUpdate({
        target: twitchUsers.twitchUserId,
        set: {
          login: chatterLogin,
          displayName: message.tags["display-name"] ?? chatterLogin,
          lastSeenAt: new Date(),
          updatedAt: new Date()
        }
      });
  }

  const currentStream = await findCurrentStream(db, broadcaster.twitchUserId);
  const messageId = message.tags.id ?? rawIrcMessageId;
  const sentAt = parseTmiTimestamp(message.tags["tmi-sent-ts"]);
  const receivedAt = new Date();

  await db
    .insert(chatMessages)
    .values({
      twitchMessageId: messageId,
      broadcasterUserId: broadcaster.twitchUserId,
      twitchStreamId: currentStream?.twitchStreamId ?? null,
      chatterUserId: chatterUserId ?? null,
      chatterLogin,
      source: "irc",
      sentAt,
      receivedAt,
      messageType: "privmsg",
      rawText: message.trailing,
      badges: parseBadgeTag(message.tags.badges),
      emotes: { raw: message.tags.emotes ?? "" },
      replyParentMessageId: message.tags["reply-parent-msg-id"] ?? null,
      rawIrcMessageId
    })
    .onConflictDoNothing();

  await touchAssignmentActivity(db, botAccountId, broadcaster.twitchUserId, {
    lastMessageAt: sentAt ?? receivedAt
  });
};

const persistMembershipEvent = async (
  db: DbClient,
  botAccountId: string,
  message: ParsedIrcMessage,
  rawIrcMessageId: string,
  channelLogin: string | null
) => {
  const broadcaster = await findUserByLogin(db, channelLogin);
  if (broadcaster == null) {
    return;
  }

  const currentStream = await findCurrentStream(db, broadcaster.twitchUserId);
  const eventAt = new Date();
  await db.insert(chatMembershipEvents).values({
    broadcasterUserId: broadcaster.twitchUserId,
    chatterLogin: getUserLogin(message),
    twitchStreamId: currentStream?.twitchStreamId ?? null,
    eventType: message.command === "JOIN" ? "join" : "part",
    source: "irc_membership",
    confidence: 70,
    dedupeKey: membershipDedupeKey({
      broadcasterUserId: broadcaster.twitchUserId,
      twitchStreamId: currentStream?.twitchStreamId ?? null,
      eventType: message.command === "JOIN" ? "join" : "part",
      chatterLogin: getUserLogin(message),
      eventAt
    }),
    eventAt,
    receivedAt: eventAt,
    rawIrcMessageId
  }).onConflictDoNothing({
    target: chatMembershipEvents.dedupeKey
  });

  await touchAssignmentActivity(db, botAccountId, broadcaster.twitchUserId, {
    lastMembershipEventAt: eventAt
  });
};

const markAssignmentJoined = async (db: DbClient, botAccountId: string, channelLogin: string | null) => {
  const broadcaster = await findUserByLogin(db, channelLogin);
  if (broadcaster == null) {
    return;
  }

  await createChatAssignmentControl(db).record({
    type: "room_observed",
    botAccountId,
    broadcasterUserId: broadcaster.twitchUserId,
    observedAt: new Date()
  });
};

const markAssignmentParted = async (db: DbClient, botAccountId: string, channelLogin: string | null) => {
  const broadcaster = await findUserByLogin(db, channelLogin);
  if (broadcaster == null) {
    return;
  }

  await createChatAssignmentControl(db).record({
    type: "room_parted",
    botAccountId,
    broadcasterUserId: broadcaster.twitchUserId,
    observedAt: new Date()
  });
};

const touchAssignmentActivity = async (
  db: DbClient,
  botAccountId: string,
  broadcasterUserId: string,
  values: {
    lastMessageAt?: Date;
    lastMembershipEventAt?: Date;
  }
) => {
  await createChatAssignmentControl(db).record({
    type: "room_observed",
    botAccountId,
    broadcasterUserId,
    observedAt: new Date(),
    ...(values.lastMessageAt == null ? {} : { lastMessageAt: values.lastMessageAt }),
    ...(values.lastMembershipEventAt == null ? {} : { lastMembershipEventAt: values.lastMembershipEventAt })
  });
};

const markDeletedChatMessage = async (db: DbClient, message: ParsedIrcMessage) => {
  const targetMessageId = message.tags["target-msg-id"];
  if (targetMessageId == null || targetMessageId === "") {
    return;
  }

  const deletedAt = parseTmiTimestamp(message.tags["tmi-sent-ts"]) ?? new Date();
  await db
    .update(chatMessages)
    .set({
      deletedAt,
      updatedAt: new Date()
    })
    .where(eq(chatMessages.twitchMessageId, targetMessageId));
};

const markClearedChatMessages = async (db: DbClient, message: ParsedIrcMessage, channelLogin: string | null) => {
  const broadcaster = await findUserByLogin(db, channelLogin);
  if (broadcaster == null) {
    return;
  }

  const currentStream = await findCurrentStream(db, broadcaster.twitchUserId);
  if (currentStream == null) {
    return;
  }

  const clearedAt = parseTmiTimestamp(message.tags["tmi-sent-ts"]) ?? new Date();
  const targetUserId = message.tags["target-user-id"];
  await db.execute(sql`
    update chat_messages
    set cleared_at = ${clearedAt},
        updated_at = now()
    where broadcaster_user_id = ${broadcaster.twitchUserId}
      and twitch_stream_id = ${currentStream.twitchStreamId}
      and received_at <= ${clearedAt}
      and (${targetUserId ?? null}::text is null or chatter_user_id = ${targetUserId ?? null})
  `);
};

const persistUserNoticeEvent = async (db: DbClient, message: ParsedIrcMessage, rawIrcMessageId: string, channelLogin: string | null) => {
  const broadcaster = await findUserByLogin(db, channelLogin);
  if (broadcaster == null) {
    return;
  }

  const actorUserId = message.tags["user-id"] ?? null;
  if (actorUserId != null) {
    await upsertObservedTwitchUser(db, {
      twitchUserId: actorUserId,
      login: message.tags.login ?? getUserLogin(message),
      displayName: message.tags["display-name"] ?? message.tags.login ?? getUserLogin(message)
    });
  }

  const currentStream = await findCurrentStream(db, broadcaster.twitchUserId);
  const eventType = `irc.usernotice.${message.tags["msg-id"] ?? "unknown"}`;
  await db
    .insert(channelEvents)
    .values({
      eventType,
      broadcasterUserId: broadcaster.twitchUserId,
      twitchStreamId: currentStream?.twitchStreamId ?? null,
      actorUserId,
      occurredAt: parseTmiTimestamp(message.tags["tmi-sent-ts"]) ?? new Date(),
      source: "irc",
      sourceEventId: message.tags.id ?? rawIrcMessageId,
      rawIrcMessageId
    })
    .onConflictDoNothing({
      target: [channelEvents.source, channelEvents.eventType, channelEvents.sourceEventId]
    });
};

const persistNoticeEvent = async (
  db: DbClient,
  botAccountId: string,
  message: ParsedIrcMessage,
  rawIrcMessageId: string,
  channelLogin: string | null
) => {
  const msgId = message.tags["msg-id"] ?? "unknown";
  const broadcaster = await findUserByLogin(db, channelLogin);
  if (broadcaster != null) {
    const currentStream = await findCurrentStream(db, broadcaster.twitchUserId);
    await db
      .insert(channelEvents)
      .values({
        eventType: `irc.notice.${msgId}`,
        broadcasterUserId: broadcaster.twitchUserId,
        twitchStreamId: currentStream?.twitchStreamId ?? null,
        actorUserId: null,
        occurredAt: new Date(),
        source: "irc",
        sourceEventId: `${rawIrcMessageId}:${msgId}`,
        rawIrcMessageId
      })
      .onConflictDoNothing({
        target: [channelEvents.source, channelEvents.eventType, channelEvents.sourceEventId]
      });

    if (isAssignmentBlockingNotice(msgId)) {
      const error = `IRC NOTICE ${msgId}: ${message.trailing ?? ""}`.trim();
      await createChatAssignmentControl(db).record({
        type: "assignment_failed",
        botAccountId,
        broadcasterUserId: broadcaster.twitchUserId,
        error,
        observedAt: new Date()
      });
    }
  }
};

const upsertObservedTwitchUser = async (
  db: DbClient,
  input: { twitchUserId: string; login: string | null; displayName: string | null }
) => {
  const now = new Date();
  const updateSet: Partial<typeof twitchUsers.$inferInsert> = {
    lastSeenAt: now,
    updatedAt: now
  };
  if (input.login != null) {
    updateSet.login = input.login;
  }
  if (input.displayName != null) {
    updateSet.displayName = input.displayName;
  }

  await db
    .insert(twitchUsers)
    .values({
      twitchUserId: input.twitchUserId,
      login: input.login,
      displayName: input.displayName,
      firstSeenAt: now,
      lastSeenAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: twitchUsers.twitchUserId,
      set: updateSet
    });
};

const isAssignmentBlockingNotice = (msgId: string) => {
  return ["msg_banned", "msg_channel_blocked", "msg_channel_suspended", "tos_ban"].includes(msgId);
};

const membershipDedupeKey = (input: {
  broadcasterUserId: string;
  twitchStreamId: string | null;
  eventType: "join" | "part";
  chatterLogin: string | null;
  eventAt: Date;
}) => {
  const eventSecond = new Date(Math.floor(input.eventAt.getTime() / 1000) * 1000).toISOString();
  return [
    "irc_membership",
    input.broadcasterUserId,
    input.twitchStreamId ?? "no-stream",
    input.eventType,
    input.chatterLogin ?? "unknown",
    eventSecond
  ].join(":");
};

const findUserByLogin = async (db: DbClient, login: string | null) => {
  if (login == null) {
    return null;
  }

  const [user] = await db
    .select({ twitchUserId: twitchUsers.twitchUserId })
    .from(twitchUsers)
    .where(eq(twitchUsers.login, login.toLowerCase()))
    .limit(1);

  return user ?? null;
};

const findCurrentStream = async (db: DbClient, broadcasterUserId: string) => {
  const [stream] = await db
    .select({ twitchStreamId: streamSessions.twitchStreamId })
    .from(streamSessions)
    .where(and(eq(streamSessions.broadcasterUserId, broadcasterUserId), isNull(streamSessions.endedAt)))
    .orderBy(desc(streamSessions.lastSeenLiveAt))
    .limit(1);

  return stream ?? null;
};

const getChannelLogin = (message: ParsedIrcMessage): string | null => {
  const channelParam = message.params.find((param) => param.startsWith("#"));
  return channelParam == null ? null : channelParam.slice(1).toLowerCase();
};

const getUserLogin = (message: ParsedIrcMessage): string | null => {
  if (message.prefix == null) {
    return null;
  }

  const [login] = message.prefix.split("!", 2);
  return login == null || login === "" ? null : login.toLowerCase();
};

const parseTmiTimestamp = (value: string | undefined): Date | null => {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
};

const parseBadgeTag = (value: string | undefined): Record<string, string> => {
  if (value == null || value === "") {
    return {};
  }

  return Object.fromEntries(
    value.split(",").flatMap((badge) => {
      const [name, version] = badge.split("/", 2);
      return name == null || name === "" ? [] : [[name, version ?? ""]];
    })
  );
};

export const parseRawIrcForTest = parseIrcLine;
