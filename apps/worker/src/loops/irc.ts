import {
  chatAssignments,
  chatMembershipEvents,
  chatMessages,
  botAccounts,
  rawIrcMessages,
  streamSessions,
  twitchUsers,
  type DbClient
} from "@twitch-tracker/db";
import { parseIrcLine, SocketIrcAdapter, type ParsedIrcMessage, type TwitchIrcAdapter } from "@twitch-tracker/twitch";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { WorkerContext } from "../worker.js";
import { startIntervalLoop } from "./common.js";

export const runIrcLoop = (context: WorkerContext) => {
  let adapter: TwitchIrcAdapter | null = null;
  let connected = false;

  context.abortSignal.addEventListener("abort", () => {
    if (adapter != null) {
      void adapter.disconnect("worker_shutdown");
    }
  });

  startIntervalLoop({
    name: "irc",
    intervalMs: context.config.ASSIGNMENT_INTERVAL_MS,
    context,
    run: async () => {
      if (!context.config.ENABLE_TWITCH_INGESTION) {
        return { activeConnections: 0, skipped: "ENABLE_TWITCH_INGESTION is false." };
      }

      if (context.config.TWITCH_BOT_LOGIN === "" || context.config.TWITCH_BOT_ACCESS_TOKEN === "") {
        return { activeConnections: 0, skipped: "Bot login/access token is not configured." };
      }

      const bot = await findBotAccount(context.db, context.config.TWITCH_BOT_LOGIN);
      if (bot == null) {
        return { activeConnections: 0, skipped: "Bot account has not been created by assignment loop yet." };
      }

      if (adapter == null || !connected) {
        adapter = new SocketIrcAdapter({
          login: context.config.TWITCH_BOT_LOGIN,
          oauthToken: context.config.TWITCH_BOT_ACCESS_TOKEN,
          events: {
            connected: () => {
              connected = true;
            },
            disconnected: () => {
              connected = false;
              adapter = null;
            },
            rawMessage: async (message) => {
              await persistRawIrcMessage(context.db, bot.id, message);
            },
            error: (error) => {
              console.error(JSON.stringify({ level: "error", loop: "irc", message: error.message }));
            }
          }
        });
        await adapter.connect();
      }

      const desiredAssignments = await context.db
        .select({
          assignmentId: chatAssignments.id,
          broadcasterUserId: chatAssignments.broadcasterUserId,
          channelLogin: twitchUsers.login
        })
        .from(chatAssignments)
        .leftJoin(twitchUsers, eq(chatAssignments.broadcasterUserId, twitchUsers.twitchUserId))
        .leftJoin(streamSessions, eq(chatAssignments.twitchStreamId, streamSessions.twitchStreamId))
        .where(and(eq(chatAssignments.botAccountId, bot.id), eq(chatAssignments.status, "desired"), isNull(streamSessions.endedAt)))
        .orderBy(desc(chatAssignments.priorityScore), desc(chatAssignments.updatedAt))
        .limit(context.config.DEFAULT_BOT_JOIN_CAPACITY);

      let joined = 0;
      for (const assignment of desiredAssignments) {
        if (assignment.channelLogin == null) {
          continue;
        }

        await adapter.join(assignment.channelLogin);
        await context.db
          .update(chatAssignments)
          .set({
            status: "joined",
            joinedAt: new Date(),
            updatedAt: new Date()
          })
          .where(eq(chatAssignments.id, assignment.assignmentId));
        joined += 1;
      }

      return {
        activeConnections: connected ? 1 : 0,
        joinedAssignments: joined
      };
    }
  });
};

const findBotAccount = async (db: DbClient, login: string) => {
  const [bot] = await db.select({ id: botAccounts.id }).from(botAccounts).where(eq(botAccounts.login, login)).limit(1);
  return bot ?? null;
};

const persistRawIrcMessage = async (db: DbClient, botAccountId: string, message: ParsedIrcMessage) => {
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
    await persistChatMessage(db, message, raw.id, channelLogin);
  }

  if (message.command === "JOIN" || message.command === "PART") {
    await persistMembershipEvent(db, message, raw.id, channelLogin);
  }
};

const persistChatMessage = async (db: DbClient, message: ParsedIrcMessage, rawIrcMessageId: string, channelLogin: string | null) => {
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
      receivedAt: new Date(),
      messageType: "privmsg",
      rawText: message.trailing,
      badges: parseBadgeTag(message.tags.badges),
      emotes: { raw: message.tags.emotes ?? "" },
      replyParentMessageId: message.tags["reply-parent-msg-id"] ?? null,
      rawIrcMessageId
    })
    .onConflictDoNothing();
};

const persistMembershipEvent = async (db: DbClient, message: ParsedIrcMessage, rawIrcMessageId: string, channelLogin: string | null) => {
  const broadcaster = await findUserByLogin(db, channelLogin);
  if (broadcaster == null) {
    return;
  }

  const currentStream = await findCurrentStream(db, broadcaster.twitchUserId);
  await db.insert(chatMembershipEvents).values({
    broadcasterUserId: broadcaster.twitchUserId,
    chatterLogin: getUserLogin(message),
    twitchStreamId: currentStream?.twitchStreamId ?? null,
    eventType: message.command === "JOIN" ? "join" : "part",
    eventAt: new Date(),
    receivedAt: new Date(),
    rawIrcMessageId
  });
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
