import {
  channels,
  rawHelixResponses,
  streamSessions,
  streamSnapshots,
  twitchUsers
} from "@twitch-tracker/db";
import type { HelixStream } from "@twitch-tracker/twitch";
import { eq } from "drizzle-orm";
import type { WorkerContext } from "../worker.js";
import { startIntervalLoop } from "./common.js";

export const runDiscoveryLoop = (context: WorkerContext) => {
  startIntervalLoop({
    name: "discovery",
    intervalMs: context.config.DISCOVERY_INTERVAL_MS,
    context,
    run: async () => {
      const raw = await context.rest.getLiveStreamsByLanguage({
        language: "fi",
        first: 100,
        accessToken: context.config.TWITCH_BOT_ACCESS_TOKEN
      });

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

      for (const stream of raw.responseJson.data) {
        await upsertStream(context, stream, rawRow.id);
      }

      return {
        discoveredStreams: raw.responseJson.data.length,
        statusCode: raw.statusCode,
        disabled: raw.statusCode === 0
      };
    }
  });
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
