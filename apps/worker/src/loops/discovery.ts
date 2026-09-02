import {
  channels,
  closeSupersededLiveStreamSessions,
  rateLimitObservations,
  rawHelixResponses,
  streamSessions,
  streamSnapshots,
  subjectPrivacyStates,
  twitchUsers
} from "@twitch-tracker/db";
import type { HelixStream, HelixUsersResponse, RawTwitchResponse } from "@twitch-tracker/twitch";
import { and, desc, eq, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { resolvePrimaryBotCredentials } from "../bot-auth.js";
import { getFinnishStreamMatchReason, type FinnishStreamMatchReason } from "../finnish-stream.js";
import { upsertTwitchUserMetadata } from "../twitch-user-metadata.js";
import type { WorkerContext } from "../worker.js";
import { startIntervalLoop } from "./common.js";

const maxDiscoveryPages = 20;
const twitchUserBatchSize = 100;

export const runDiscoveryLoop = (context: WorkerContext) => {
  let nextKnownChannelDiscoveryAt = 0;

  return startIntervalLoop({
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
      let responseStreamRows = 0;
      let pages = 0;
      let lastStatusCode = 0;
      let paginationTruncated = false;
      let hydratedBroadcasters = 0;
      let userMetadataFailures = 0;
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
          break;
        }

        const streams = Array.isArray(raw.responseJson.data) ? raw.responseJson.data : [];
        responseStreamRows += streams.length;
        const hydration = await hydrateBroadcasterMetadata(
          context,
          streams,
          bot.accessToken,
          bot.botAccountId
        );
        hydratedBroadcasters += hydration.hydratedBroadcasters;
        userMetadataFailures += hydration.failed ? 1 : 0;
        for (const stream of streams) {
          if (seenStreamIds.has(stream.id)) {
            continue;
          }
          seenStreamIds.add(stream.id);
          await upsertStream(context, stream, rawRowId, "language");
        }

        after = getPaginationCursor(raw.pagination);
        if (after != null && pages >= maxDiscoveryPages) {
          paginationTruncated = true;
          break;
        }
      } while (after != null);

      let knownChannelDiscovery: KnownChannelDiscoveryResult | null = null;
      if (Date.now() >= nextKnownChannelDiscoveryAt) {
        knownChannelDiscovery = await scanKnownChannels(context, {
          accessToken: bot.accessToken,
          botAccountId: bot.botAccountId,
          languageStreamIds: seenStreamIds,
          observedAt: startedAt
        });
        nextKnownChannelDiscoveryAt = Date.now() + context.config.KNOWN_CHANNEL_DISCOVERY_INTERVAL_MS;
      }

      return {
        discoveredStreams: seenStreamIds.size,
        duplicateStreamRows: responseStreamRows - seenStreamIds.size,
        pages,
        statusCode: lastStatusCode,
        disabled: lastStatusCode === 0,
        paginationTruncated,
        hydratedBroadcasters,
        userMetadataFailures,
        knownChannelDiscovery,
        botLogin: bot.login,
        botTokenSource: bot.source
      };
    }
  });
};

const persistRawHelixResponse = async <T>(
  context: WorkerContext,
  raw: RawTwitchResponse<T>
): Promise<string> => {
  const [rawRow] = await context.db
    .insert(rawHelixResponses)
    .values({
      endpoint: raw.endpoint,
      requestParams: raw.requestParams,
      statusCode: raw.statusCode,
      responseJson: raw.responseJson,
      pagination: raw.pagination,
      rateLimitHeaders: {},
      observedAt: raw.observedAt
    })
    .returning({ id: rawHelixResponses.id });

  if (rawRow == null) {
    throw new Error("Failed to persist raw Helix response.");
  }

  return rawRow.id;
};

const recordRateLimitObservation = async <T>(
  context: WorkerContext,
  raw: RawTwitchResponse<T>,
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

const hydrateBroadcasterMetadata = async (
  context: WorkerContext,
  streams: HelixStream[],
  accessToken: string,
  botAccountId: string | null
): Promise<{ hydratedBroadcasters: number; failed: boolean }> => {
  const userIds = [...new Set(streams.map((stream) => stream.user_id))];
  if (userIds.length === 0) {
    return { hydratedBroadcasters: 0, failed: false };
  }

  const metadataRows = await context.db
    .select({
      twitchUserId: twitchUsers.twitchUserId,
      lastMetadataRefreshAt: twitchUsers.lastMetadataRefreshAt
    })
    .from(twitchUsers)
    .where(inArray(twitchUsers.twitchUserId, userIds));
  const refreshCutoff = Date.now() - context.config.BROADCASTER_METADATA_REFRESH_INTERVAL_MS;
  const freshUserIds = new Set(
    metadataRows
      .filter((row) => row.lastMetadataRefreshAt != null && row.lastMetadataRefreshAt.getTime() >= refreshCutoff)
      .map((row) => row.twitchUserId)
  );
  const staleUserIds = userIds.filter((userId) => !freshUserIds.has(userId));
  if (staleUserIds.length === 0) {
    return { hydratedBroadcasters: 0, failed: false };
  }

  let raw: RawTwitchResponse<HelixUsersResponse>;
  try {
    raw = await context.rest.getUsers({ ids: staleUserIds, accessToken });
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      loop: "discovery",
      operation: "hydrate_broadcasters",
      message: error instanceof Error ? error.message : String(error)
    }));
    return { hydratedBroadcasters: 0, failed: true };
  }

  await persistRawHelixResponse(context, raw);
  await recordRateLimitObservation(context, raw, botAccountId);
  if (raw.statusCode < 200 || raw.statusCode >= 300) {
    return { hydratedBroadcasters: 0, failed: true };
  }

  const observedAt = new Date();
  for (const user of raw.responseJson.data) {
    await upsertTwitchUserMetadata(context.db, user, observedAt);
  }
  return { hydratedBroadcasters: raw.responseJson.data.length, failed: false };
};

const scanKnownChannels = async (
  context: WorkerContext,
  input: {
    accessToken: string;
    botAccountId: string | null;
    languageStreamIds: Set<string>;
    observedAt: Date;
  }
): Promise<KnownChannelDiscoveryResult> => {
  const knownChannels = await context.db
    .select({
      twitchUserId: channels.twitchUserId,
      isManuallyPinned: channels.isManuallyPinned
    })
    .from(channels)
    .leftJoin(subjectPrivacyStates, eq(channels.twitchUserId, subjectPrivacyStates.twitchUserId))
    .where(and(
      or(eq(channels.hasBeenSeenFinnish, true), eq(channels.isManuallyPinned, true)),
      or(isNull(subjectPrivacyStates.twitchUserId), eq(subjectPrivacyStates.trackingOptedOut, false))
    ))
    .orderBy(channels.twitchUserId);
  const result: KnownChannelDiscoveryResult = {
    checkedChannels: knownChannels.length,
    successfulBatches: 0,
    failedBatches: 0,
    liveStreams: 0,
    recoveredLanguageStreams: 0,
    tagMatchedStreams: 0,
    manuallyMatchedStreams: 0,
    ineligibleLiveStreams: 0,
    closedStreams: 0
  };
  let rateLimitSample: RawTwitchResponse<unknown> | null = null;

  for (let offset = 0; offset < knownChannels.length; offset += twitchUserBatchSize) {
    const batch = knownChannels.slice(offset, offset + twitchUserBatchSize);
    let raw: RawTwitchResponse<{ data: HelixStream[] }>;
    try {
      raw = await context.rest.getLiveStreamsByUserIds({
        userIds: batch.map((channel) => channel.twitchUserId),
        accessToken: input.accessToken
      });
    } catch (error) {
      result.failedBatches += 1;
      console.error(JSON.stringify({
        level: "error",
        loop: "discovery",
        operation: "scan_known_channels",
        message: error instanceof Error ? error.message : String(error)
      }));
      continue;
    }
    if (
      rateLimitSample == null
      || (raw.rateLimit.remaining != null
        && (rateLimitSample.rateLimit.remaining == null || raw.rateLimit.remaining < rateLimitSample.rateLimit.remaining))
    ) {
      rateLimitSample = raw;
    }
    if (raw.statusCode < 200 || raw.statusCode >= 300) {
      result.failedBatches += 1;
      if (raw.statusCode === 401 || raw.statusCode === 403) {
        result.failedBatches += Math.ceil((knownChannels.length - offset - batch.length) / twitchUserBatchSize);
        break;
      }
      continue;
    }

    result.successfulBatches += 1;
    const streams = Array.isArray(raw.responseJson.data) ? raw.responseJson.data : [];
    result.liveStreams += streams.length;
    const channelById = new Map(batch.map((channel) => [channel.twitchUserId, channel]));
    const returnedChannelIds = new Set<string>();
    for (const stream of streams) {
      returnedChannelIds.add(stream.user_id);
      const matchReason = getFinnishStreamMatchReason({
        language: stream.language,
        tags: stream.tags,
        manuallyPinned: channelById.get(stream.user_id)?.isManuallyPinned ?? false
      });
      if (matchReason == null) {
        result.ineligibleLiveStreams += 1;
        await markKnownStreamLiveButIneligible(context, stream, input.observedAt);
        continue;
      }
      if (matchReason === "language" && input.languageStreamIds.has(stream.id)) {
        continue;
      }

      if (matchReason === "language") {
        result.recoveredLanguageStreams += 1;
      } else if (matchReason === "tag") {
        result.tagMatchedStreams += 1;
      } else {
        result.manuallyMatchedStreams += 1;
      }
      await upsertStream(context, stream, null, matchReason);
    }

    result.closedStreams += await closeKnownStreamsMissingFromBatch(
      context,
      batch.map((channel) => channel.twitchUserId).filter((userId) => !returnedChannelIds.has(userId)),
      input.observedAt
    );
  }

  if (rateLimitSample != null) {
    await recordRateLimitObservation(context, rateLimitSample, input.botAccountId);
  }
  return result;
};

const closeKnownStreamsMissingFromBatch = async (
  context: WorkerContext,
  broadcasterUserIds: string[],
  observedAt: Date
): Promise<number> => {
  if (broadcasterUserIds.length === 0) {
    return 0;
  }
  const staleBefore = new Date(
    observedAt.getTime() - context.config.STREAM_END_GRACE_MINUTES * 60_000
  );
  const closed = await context.db
    .update(streamSessions)
    .set({
      endedAt: observedAt,
      endDetectionSource: "rest.known_channels.missing",
      updatedAt: new Date()
    })
    .where(and(
      inArray(streamSessions.broadcasterUserId, broadcasterUserIds),
      isNull(streamSessions.endedAt),
      lte(streamSessions.lastSeenLiveAt, staleBefore)
    ))
    .returning({ twitchStreamId: streamSessions.twitchStreamId });
  return closed.length;
};

const getPaginationCursor = (pagination: Record<string, unknown>): string | undefined => {
  const cursor = pagination.cursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
};

const upsertStream = async (
  context: WorkerContext,
  stream: HelixStream,
  rawHelixResponseId: string | null,
  finnishMatchReason: FinnishStreamMatchReason
) => {
  const now = new Date();
  const startedAt = new Date(stream.started_at);
  const tags = stream.tags ?? stream.tag_ids ?? [];

  await closeSupersededLiveStreamSessions(context.db, {
    broadcasterUserId: stream.user_id,
    currentStreamId: stream.id,
    observedAt: now,
    source: "rest.stream.superseded"
  });

  await context.db
    .insert(twitchUsers)
    .values({
      twitchUserId: stream.user_id,
      login: stream.user_login,
      displayName: stream.user_name,
      firstSeenAt: now,
      lastSeenAt: now
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
      finnishMatchReason,
      isFinnishEligible: true,
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
        endedAt: null,
        lastSeenLiveAt: now,
        endDetectionSource: null,
        language: stream.language,
        finnishMatchReason,
        isFinnishEligible: true,
        latestTitle: stream.title,
        latestCategoryId: stream.game_id,
        latestCategoryName: stream.game_name,
        mature: stream.is_mature ?? null,
        updatedAt: now
      }
    });

  const [latestMetadata] = await context.db
    .select({
      title: streamSnapshots.title,
      categoryId: streamSnapshots.categoryId,
      categoryName: streamSnapshots.categoryName,
      language: streamSnapshots.language,
      tags: streamSnapshots.tags,
      thumbnailUrl: streamSnapshots.thumbnailUrl
    })
    .from(streamSnapshots)
    .where(and(
      eq(streamSnapshots.twitchStreamId, stream.id),
      isNotNull(streamSnapshots.title)
    ))
    .orderBy(desc(streamSnapshots.observedAt), desc(streamSnapshots.id))
    .limit(1);
  const metadataChanged = latestMetadata == null
    || latestMetadata.title !== stream.title
    || latestMetadata.categoryId !== stream.game_id
    || latestMetadata.categoryName !== stream.game_name
    || latestMetadata.language !== stream.language
    || latestMetadata.thumbnailUrl !== stream.thumbnail_url
    || !sameStringArray(latestMetadata.tags, tags);

  await context.db.insert(streamSnapshots).values({
    twitchStreamId: stream.id,
    broadcasterUserId: stream.user_id,
    observedAt: now,
    viewerCount: stream.viewer_count,
    title: metadataChanged ? stream.title : null,
    categoryId: metadataChanged ? stream.game_id : null,
    categoryName: metadataChanged ? stream.game_name : null,
    language: metadataChanged ? stream.language : null,
    tags: metadataChanged ? tags : [],
    thumbnailUrl: metadataChanged ? stream.thumbnail_url : null,
    sourceRunId: rawHelixResponseId
  });
};

const markKnownStreamLiveButIneligible = async (
  context: WorkerContext,
  stream: HelixStream,
  observedAt: Date
) => {
  await closeSupersededLiveStreamSessions(context.db, {
    broadcasterUserId: stream.user_id,
    currentStreamId: stream.id,
    observedAt,
    source: "rest.stream.superseded"
  });

  await context.db
    .update(streamSessions)
    .set({
      endedAt: null,
      lastSeenLiveAt: observedAt,
      endDetectionSource: null,
      language: stream.language,
      isFinnishEligible: false,
      latestTitle: stream.title,
      latestCategoryId: stream.game_id,
      latestCategoryName: stream.game_name,
      mature: stream.is_mature ?? null,
      updatedAt: observedAt
    })
    .where(eq(streamSessions.twitchStreamId, stream.id));
};

type KnownChannelDiscoveryResult = {
  checkedChannels: number;
  successfulBatches: number;
  failedBatches: number;
  liveStreams: number;
  recoveredLanguageStreams: number;
  tagMatchedStreams: number;
  manuallyMatchedStreams: number;
  ineligibleLiveStreams: number;
  closedStreams: number;
};

const sameStringArray = (left: string[], right: string[]) => {
  return left.length === right.length && left.every((value, index) => value === right[index]);
};
