import {
  channels,
  chatAssignments,
  chatPresenceObservations,
  chatPresenceSnapshots,
  rateLimitObservations,
  rawHelixResponses,
  streamSessions,
  twitchUsers,
  type DbClient
} from "@twitch-tracker/db";
import type {
  HelixChatter,
  HelixChattersResponse,
  HelixModeratedChannelsResponse,
  RawTwitchResponse
} from "@twitch-tracker/twitch";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { resolvePrimaryBotCredentials } from "../bot-auth.js";
import type { WorkerContext } from "../worker.js";
import { startIntervalLoop } from "./common.js";

const getChattersSource = "helix.get_chatters";
const presenceConfidence = 90;

export const runChattersReconciliationLoop = (context: WorkerContext) => {
  startIntervalLoop({
    name: "chatters-reconciliation",
    intervalMs: context.config.CHATTERS_RECONCILIATION_INTERVAL_MS,
    context,
    run: async () => {
      if (!context.config.ENABLE_TWITCH_INGESTION) {
        return { skipped: "ENABLE_TWITCH_INGESTION is false.", channelsSampled: 0 };
      }

      if (context.config.TWITCH_CLIENT_ID === "") {
        return { skipped: "TWITCH_CLIENT_ID is not configured.", channelsSampled: 0 };
      }

      const bot = await resolvePrimaryBotCredentials(context.db, context.config);
      if (bot.botAccountId == null || bot.login == null || bot.accessToken == null) {
        return { skipped: "No valid bot access token is configured.", channelsSampled: 0, botLogin: bot.login };
      }

      if (bot.twitchUserId == null) {
        return { skipped: "Bot Twitch user ID is required for Get Chatters.", channelsSampled: 0, botLogin: bot.login };
      }

      if (!bot.scopes.includes("user:read:moderated_channels") || !bot.scopes.includes("moderator:read:chatters")) {
        return {
          skipped: "Bot token is missing user:read:moderated_channels or moderator:read:chatters.",
          channelsSampled: 0,
          botLogin: bot.login,
          scopes: bot.scopes
        };
      }

      const moderated = await syncModeratedChannels(context, bot.twitchUserId, bot.accessToken, bot.botAccountId);
      const candidates = await findCandidateChannels(context, bot.botAccountId);
      let channelsSampled = 0;
      let observationsInserted = 0;
      let failedChannels = 0;

      for (const candidate of candidates) {
        try {
          const result = await sampleChattersForChannel(context, {
            botAccountId: bot.botAccountId,
            botUserId: bot.twitchUserId,
            accessToken: bot.accessToken,
            broadcasterUserId: candidate.broadcasterUserId,
            twitchStreamId: candidate.twitchStreamId
          });
          channelsSampled += 1;
          observationsInserted += result.observationsInserted;
        } catch (error) {
          failedChannels += 1;
          await markSnapshotFailed(context.db, {
            botAccountId: bot.botAccountId,
            broadcasterUserId: candidate.broadcasterUserId,
            twitchStreamId: candidate.twitchStreamId,
            error
          });
        }
      }

      return {
        botLogin: bot.login,
        botTokenSource: bot.source,
        moderatedChannels: moderated.moderatedChannels,
        candidates: candidates.length,
        channelsSampled,
        observationsInserted,
        failedChannels
      };
    }
  });
};

const syncModeratedChannels = async (
  context: WorkerContext,
  botUserId: string,
  accessToken: string,
  botAccountId: string
): Promise<{ moderatedChannels: number }> => {
  const moderatedIds = new Set<string>();
  let cursor: string | undefined;
  let successful = true;

  do {
    const request: {
      userId: string;
      accessToken: string;
      first: number;
      after?: string;
    } = {
      userId: botUserId,
      accessToken,
      first: 100
    };
    if (cursor != null) {
      request.after = cursor;
    }

    const raw = await context.rest.getModeratedChannels(request);
    await persistRawHelixResponse(context, raw);
    await recordRateLimitObservation(context, raw, botAccountId);

    if (raw.statusCode < 200 || raw.statusCode >= 300) {
      successful = false;
      break;
    }

    for (const channel of raw.responseJson.data) {
      moderatedIds.add(channel.broadcaster_id);
      const now = new Date();
      await context.db
        .insert(twitchUsers)
        .values({
          twitchUserId: channel.broadcaster_id,
          login: channel.broadcaster_login,
          displayName: channel.broadcaster_name,
          firstSeenAt: now,
          lastSeenAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: twitchUsers.twitchUserId,
          set: {
            login: channel.broadcaster_login,
            displayName: channel.broadcaster_name,
            lastSeenAt: now,
            updatedAt: now
          }
        });

      await context.db
        .insert(channels)
        .values({
          twitchUserId: channel.broadcaster_id,
          isKnownModerator: true,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: channels.twitchUserId,
          set: {
            isKnownModerator: true,
            updatedAt: now
          }
        });
    }

    cursor = getPaginationCursor(raw.pagination);
  } while (cursor != null);

  if (successful) {
    const knownModerated = await context.db
      .select({ twitchUserId: channels.twitchUserId })
      .from(channels)
      .where(eq(channels.isKnownModerator, true));

    for (const known of knownModerated) {
      if (moderatedIds.has(known.twitchUserId)) {
        continue;
      }

      await context.db
        .update(channels)
        .set({
          isKnownModerator: false,
          updatedAt: new Date()
        })
        .where(eq(channels.twitchUserId, known.twitchUserId));
    }
  }

  return { moderatedChannels: moderatedIds.size };
};

const findCandidateChannels = async (context: WorkerContext, botAccountId: string) => {
  const rows = await context.db
    .select({
      broadcasterUserId: chatAssignments.broadcasterUserId,
      twitchStreamId: chatAssignments.twitchStreamId
    })
    .from(chatAssignments)
    .innerJoin(channels, eq(chatAssignments.broadcasterUserId, channels.twitchUserId))
    .leftJoin(streamSessions, eq(chatAssignments.twitchStreamId, streamSessions.twitchStreamId))
    .where(
      and(
        eq(chatAssignments.botAccountId, botAccountId),
        inArray(chatAssignments.status, ["joined", "joining"]),
        eq(channels.isKnownModerator, true),
        isNull(streamSessions.endedAt)
      )
    )
    .orderBy(desc(chatAssignments.priorityScore), desc(chatAssignments.updatedAt))
    .limit(context.config.CHATTERS_RECONCILIATION_MAX_CHANNELS);

  const seen = new Set<string>();
  const uniqueRows: Array<{ broadcasterUserId: string; twitchStreamId: string | null }> = [];
  for (const row of rows) {
    if (seen.has(row.broadcasterUserId)) {
      continue;
    }

    seen.add(row.broadcasterUserId);
    uniqueRows.push(row);
  }

  return uniqueRows;
};

const sampleChattersForChannel = async (
  context: WorkerContext,
  input: {
    botAccountId: string;
    botUserId: string;
    accessToken: string;
    broadcasterUserId: string;
    twitchStreamId: string | null;
  }
): Promise<{ observationsInserted: number }> => {
  const sampledAt = new Date();
  const chatters: HelixChatter[] = [];
  let total: number | null = null;
  let pageCount = 0;
  let cursor: string | undefined;

  do {
    pageCount += 1;
    const request: {
      broadcasterId: string;
      moderatorId: string;
      accessToken: string;
      first: number;
      after?: string;
    } = {
      broadcasterId: input.broadcasterUserId,
      moderatorId: input.botUserId,
      accessToken: input.accessToken,
      first: 1000
    };
    if (cursor != null) {
      request.after = cursor;
    }

    const raw = await context.rest.getChatters(request);
    await persistRawHelixResponse(context, raw);
    await recordRateLimitObservation(context, raw, input.botAccountId);

    if (raw.statusCode === 403) {
      await context.db
        .update(channels)
        .set({
          isKnownModerator: false,
          updatedAt: new Date()
        })
        .where(eq(channels.twitchUserId, input.broadcasterUserId));
    }

    if (raw.statusCode < 200 || raw.statusCode >= 300) {
      throw new Error(`Get Chatters failed with status ${raw.statusCode}.`);
    }

    chatters.push(...raw.responseJson.data);
    total = raw.responseJson.total ?? total;
    cursor = getPaginationCursor(raw.pagination);
  } while (cursor != null && pageCount < context.config.CHATTERS_RECONCILIATION_MAX_PAGES_PER_CHANNEL);

  const [snapshot] = await context.db
    .insert(chatPresenceSnapshots)
    .values({
      broadcasterUserId: input.broadcasterUserId,
      twitchStreamId: input.twitchStreamId,
      botAccountId: input.botAccountId,
      source: getChattersSource,
      confidence: presenceConfidence,
      sampledAt,
      chatterCount: total ?? chatters.length,
      pageCount,
      requestStatus: cursor == null ? "succeeded" : "truncated",
      updatedAt: sampledAt
    })
    .returning({ id: chatPresenceSnapshots.id });

  if (snapshot == null) {
    throw new Error("Failed to persist chat presence snapshot.");
  }

  let observationsInserted = 0;
  const observedMinute = floorToMinute(sampledAt).toISOString();
  for (const chatter of chatters) {
    const now = new Date();
    await context.db
      .insert(twitchUsers)
      .values({
        twitchUserId: chatter.user_id,
        login: chatter.user_login,
        displayName: chatter.user_name,
        firstSeenAt: now,
        lastSeenAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: twitchUsers.twitchUserId,
        set: {
          login: chatter.user_login,
          displayName: chatter.user_name,
          lastSeenAt: now,
          updatedAt: now
        }
      });

    const [inserted] = await context.db
      .insert(chatPresenceObservations)
      .values({
        snapshotId: snapshot.id,
        broadcasterUserId: input.broadcasterUserId,
        chatterUserId: chatter.user_id,
        chatterLogin: chatter.user_login,
        chatterDisplayName: chatter.user_name,
        twitchStreamId: input.twitchStreamId,
        observedAt: sampledAt,
        source: getChattersSource,
        confidence: presenceConfidence,
        dedupeKey: [
          getChattersSource,
          input.broadcasterUserId,
          input.twitchStreamId ?? "no-stream",
          chatter.user_id,
          observedMinute
        ].join(":")
      })
      .onConflictDoNothing({
        target: chatPresenceObservations.dedupeKey
      })
      .returning({ id: chatPresenceObservations.id });

    if (inserted != null) {
      observationsInserted += 1;
    }
  }

  return { observationsInserted };
};

const markSnapshotFailed = async (
  db: DbClient,
  input: {
    botAccountId: string;
    broadcasterUserId: string;
    twitchStreamId: string | null;
    error: unknown;
  }
) => {
  await db.insert(chatPresenceSnapshots).values({
    broadcasterUserId: input.broadcasterUserId,
    twitchStreamId: input.twitchStreamId,
    botAccountId: input.botAccountId,
    source: getChattersSource,
    confidence: 0,
    sampledAt: new Date(),
    chatterCount: 0,
    pageCount: 0,
    requestStatus: "failed",
    latestError: input.error instanceof Error ? input.error.message : String(input.error)
  });
};

const persistRawHelixResponse = async (
  context: WorkerContext,
  raw: RawTwitchResponse<HelixChattersResponse | HelixModeratedChannelsResponse>
): Promise<string> => {
  const [rawRow] = await context.db
    .insert(rawHelixResponses)
    .values({
      endpoint: raw.endpoint,
      requestParams: raw.requestParams,
      statusCode: raw.statusCode,
      responseJson: raw.responseJson,
      pagination: raw.pagination,
      rateLimitHeaders: raw.rateLimit.raw,
      observedAt: raw.observedAt
    })
    .returning({ id: rawHelixResponses.id });

  if (rawRow == null) {
    throw new Error("Failed to persist raw Helix response.");
  }

  return rawRow.id;
};

const recordRateLimitObservation = async (
  context: WorkerContext,
  raw: RawTwitchResponse<HelixChattersResponse | HelixModeratedChannelsResponse>,
  botAccountId: string | null
) => {
  await context.db.insert(rateLimitObservations).values({
    source: "helix",
    endpoint: raw.endpoint,
    botAccountId,
    limit: raw.rateLimit.limit,
    remaining: raw.rateLimit.remaining,
    resetAt: raw.rateLimit.resetAt,
    headers: raw.rateLimit.raw,
    observedAt: raw.observedAt
  });
};

const getPaginationCursor = (pagination: Record<string, unknown>): string | undefined => {
  const cursor = pagination.cursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
};

const floorToMinute = (date: Date): Date => {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
};
