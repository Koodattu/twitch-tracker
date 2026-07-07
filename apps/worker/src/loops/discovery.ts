import {
  channels,
  rateLimitObservations,
  rawHelixResponses,
  streamSessions,
  streamSnapshots,
  twitchUsers
} from "@twitch-tracker/db";
import type { HelixStream, RawTwitchResponse, HelixStreamsResponse } from "@twitch-tracker/twitch";
import { and, eq, isNull } from "drizzle-orm";
import { resolvePrimaryBotCredentials } from "../bot-auth.js";
import type { WorkerContext } from "../worker.js";
import { startIntervalLoop } from "./common.js";

const maxDiscoveryPages = 20;

export const runDiscoveryLoop = (context: WorkerContext) => {
  startIntervalLoop({
    name: "discovery",
    intervalMs: context.config.DISCOVERY_INTERVAL_MS,
    context,
    run: async () => {
      if (!context.config.ENABLE_TWITCH_INGESTION) {
        return { discoveredStreams: 0, skipped: "ENABLE_TWITCH_INGESTION is false." };
      }

      if (context.config.TWITCH_CLIENT_ID === "") {
        return { discoveredStreams: 0, skipped: "TWITCH_CLIENT_ID is not configured." };
      }

      const bot = await resolvePrimaryBotCredentials(context.db, context.config);
      if (bot.accessToken == null) {
        return { discoveredStreams: 0, skipped: "No valid bot access token is configured.", botLogin: bot.login };
      }

      const seenStreamIds = new Set<string>();
      let after: string | undefined;
      let discoveredStreams = 0;
      let pages = 0;
      let lastStatusCode = 0;
      let successful = true;
      let paginationTruncated = false;
      const startedAt = new Date();

      do {
        pages += 1;
        const request: {
          language: string;
          first: number;
          after?: string;
          accessToken: string;
        } = {
          language: "fi",
          first: 100,
          accessToken: bot.accessToken
        };
        if (after != null) {
          request.after = after;
        }

        const raw = await context.rest.getLiveStreamsByLanguage(request);
        lastStatusCode = raw.statusCode;

        const rawRowId = await persistRawHelixResponse(context, raw);
        await recordRateLimitObservation(context, raw, bot.botAccountId);

        if (raw.statusCode < 200 || raw.statusCode >= 300) {
          successful = false;
          break;
        }

        const streams = Array.isArray(raw.responseJson.data) ? raw.responseJson.data : [];
        discoveredStreams += streams.length;
        for (const stream of streams) {
          seenStreamIds.add(stream.id);
          await upsertStream(context, stream, rawRowId);
        }

        after = getPaginationCursor(raw.pagination);
        if (after != null && pages >= maxDiscoveryPages) {
          paginationTruncated = true;
          break;
        }
      } while (after != null);

      const closedStreams = successful && !paginationTruncated
        ? await closeFinnishStreamsMissingFromSuccessfulPoll(context, seenStreamIds, startedAt)
        : 0;

      return {
        discoveredStreams,
        closedStreams,
        pages,
        statusCode: lastStatusCode,
        disabled: lastStatusCode === 0,
        paginationTruncated,
        botLogin: bot.login,
        botTokenSource: bot.source
      };
    }
  });
};

const persistRawHelixResponse = async (
  context: WorkerContext,
  raw: RawTwitchResponse<HelixStreamsResponse>
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
  raw: RawTwitchResponse<HelixStreamsResponse>,
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

const closeFinnishStreamsMissingFromSuccessfulPoll = async (
  context: WorkerContext,
  seenStreamIds: Set<string>,
  endedAt: Date
): Promise<number> => {
  const liveStreams = await context.db
    .select({
      twitchStreamId: streamSessions.twitchStreamId
    })
    .from(streamSessions)
    .where(and(isNull(streamSessions.endedAt), eq(streamSessions.language, "fi")));

  let closedStreams = 0;
  for (const stream of liveStreams) {
    if (seenStreamIds.has(stream.twitchStreamId)) {
      continue;
    }

    await context.db
      .update(streamSessions)
      .set({
        endedAt,
        endDetectionSource: "rest.discovery.missing",
        updatedAt: new Date()
      })
      .where(eq(streamSessions.twitchStreamId, stream.twitchStreamId));
    closedStreams += 1;
  }

  return closedStreams;
};

const getPaginationCursor = (pagination: Record<string, unknown>): string | undefined => {
  const cursor = pagination.cursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
};

const upsertStream = async (context: WorkerContext, stream: HelixStream, rawHelixResponseId: string) => {
  const now = new Date();
  const startedAt = new Date(stream.started_at);

  await context.db
    .insert(twitchUsers)
    .values({
      twitchUserId: stream.user_id,
      login: stream.user_login,
      displayName: stream.user_name,
      firstSeenAt: now,
      lastSeenAt: now,
      lastMetadataRefreshAt: now
    })
    .onConflictDoUpdate({
      target: twitchUsers.twitchUserId,
      set: {
        login: stream.user_login,
        displayName: stream.user_name,
        lastSeenAt: now,
        updatedAt: now
      }
    });

  await context.db
    .insert(channels)
    .values({
      twitchUserId: stream.user_id,
      hasBeenSeenFinnish: true,
      firstSeenFinnishAt: now,
      lastSeenFinnishAt: now
    })
    .onConflictDoUpdate({
      target: channels.twitchUserId,
      set: {
        hasBeenSeenFinnish: true,
        lastSeenFinnishAt: now,
        updatedAt: now
      }
    });

  await context.db
    .insert(streamSessions)
    .values({
      twitchStreamId: stream.id,
      broadcasterUserId: stream.user_id,
      startedAt,
      firstSeenAt: now,
      lastSeenLiveAt: now,
      language: stream.language,
      initialTitle: stream.title,
      latestTitle: stream.title,
      initialCategoryId: stream.game_id,
      initialCategoryName: stream.game_name,
      latestCategoryId: stream.game_id,
      latestCategoryName: stream.game_name,
      mature: stream.is_mature ?? null
    })
    .onConflictDoUpdate({
      target: streamSessions.twitchStreamId,
      set: {
        lastSeenLiveAt: now,
        language: stream.language,
        latestTitle: stream.title,
        latestCategoryId: stream.game_id,
        latestCategoryName: stream.game_name,
        mature: stream.is_mature ?? null,
        updatedAt: now
      }
    });

  await context.db.insert(streamSnapshots).values({
    twitchStreamId: stream.id,
    broadcasterUserId: stream.user_id,
    observedAt: now,
    viewerCount: stream.viewer_count,
    title: stream.title,
    categoryId: stream.game_id,
    categoryName: stream.game_name,
    language: stream.language,
    tags: stream.tags ?? stream.tag_ids ?? [],
    thumbnailUrl: stream.thumbnail_url,
    sourceRunId: rawHelixResponseId
  });
};
