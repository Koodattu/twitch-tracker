import { channelDailyStats, streamActivityBuckets, streamSessions, streamSnapshots, type DbClient } from "@twitch-tracker/db";
import { and, asc, desc, eq, gte, isNull, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { detailPage, detailPageNumberSchema, detailPageSize, viewerObservationFields } from "./detail-records.js";
import { summarizeChannelPeriod } from "./channel-period.js";

export const channelDetailQuerySchema = z.object({ page: detailPageNumberSchema });

const sessionFields = {
  twitchStreamId: streamSessions.twitchStreamId, latestTitle: streamSessions.latestTitle,
  latestCategoryName: streamSessions.latestCategoryName, latestCategoryId: streamSessions.latestCategoryId, startedAt: streamSessions.startedAt,
  endedAt: streamSessions.endedAt, lastSeenLiveAt: streamSessions.lastSeenLiveAt
};
const dailyFields = {
  day: channelDailyStats.day, streamCount: channelDailyStats.streamCount, liveSeconds: channelDailyStats.liveSeconds,
  viewerCountMax: channelDailyStats.viewerCountMax, viewerCountAvg: channelDailyStats.viewerCountAvg,
  messageCount: channelDailyStats.messageCount
};

export async function getChannelOverview(db: DbClient, broadcasterId: string, maxGapSeconds = 360) {
  const now = new Date();
  const toDay = now.toISOString().slice(0, 10);
  const fromDay = new Date(Date.parse(toDay) - 29 * 86_400_000).toISOString().slice(0, 10);
  const from = new Date(fromDay);
  const [daily, recentSessions, liveSessions, periodSessions, samples] = await Promise.all([
    db.select(dailyFields).from(channelDailyStats)
      .where(and(eq(channelDailyStats.broadcasterUserId, broadcasterId), gte(channelDailyStats.day, fromDay), lte(channelDailyStats.day, toDay)))
      .orderBy(channelDailyStats.day),
    db.select(sessionFields).from(streamSessions).where(eq(streamSessions.broadcasterUserId, broadcasterId))
      .orderBy(desc(streamSessions.startedAt), desc(streamSessions.twitchStreamId)).limit(6),
    db.select(sessionFields).from(streamSessions).where(and(eq(streamSessions.broadcasterUserId, broadcasterId), isNull(streamSessions.endedAt)))
      .orderBy(desc(streamSessions.startedAt), desc(streamSessions.twitchStreamId)).limit(1),
    db.select(sessionFields).from(streamSessions).where(and(eq(streamSessions.broadcasterUserId, broadcasterId),
      lt(streamSessions.startedAt, now), gte(sql`coalesce(${streamSessions.endedAt}, ${streamSessions.lastSeenLiveAt})`, from))),
    db.select({ twitchStreamId: streamSnapshots.twitchStreamId, observedAt: streamSnapshots.observedAt,
      viewerCount: streamSnapshots.viewerCount, categoryId: streamSnapshots.categoryId, categoryName: streamSnapshots.categoryName })
      .from(streamSnapshots).where(and(eq(streamSnapshots.broadcasterUserId, broadcasterId),
        gte(streamSnapshots.observedAt, new Date(from.getTime() - maxGapSeconds * 1000)), lt(streamSnapshots.observedAt, now)))
      .orderBy(asc(streamSnapshots.twitchStreamId), asc(streamSnapshots.observedAt), asc(streamSnapshots.id))
  ]);
  return {
    fromDay, toDay, recentSessions, liveSession: liveSessions[0] ?? null,
    ...summarizeChannelPeriod({ from, to: now, maxGapSeconds, sessions: periodSessions, samples, messages: daily })
  };
}

export async function getChannelDetail(db: DbClient, broadcasterId: string, kind: "sessions" | "daily" | "observations" | "buckets", page: number) {
  const limit = detailPageSize + 1;
  const offset = (page - 1) * detailPageSize;
  switch (kind) {
    case "sessions": return detailPage(await db.select(sessionFields).from(streamSessions)
      .where(eq(streamSessions.broadcasterUserId, broadcasterId))
      .orderBy(desc(streamSessions.startedAt), desc(streamSessions.twitchStreamId)).limit(limit).offset(offset), page);
    case "daily": return detailPage(await db.select(dailyFields).from(channelDailyStats)
      .where(eq(channelDailyStats.broadcasterUserId, broadcasterId)).orderBy(desc(channelDailyStats.day)).limit(limit).offset(offset), page);
    case "observations": return detailPage(await db.select({ ...viewerObservationFields, twitchStreamId: streamSnapshots.twitchStreamId })
      .from(streamSnapshots).where(eq(streamSnapshots.broadcasterUserId, broadcasterId))
      .orderBy(desc(streamSnapshots.observedAt), desc(streamSnapshots.id)).limit(limit).offset(offset), page);
    case "buckets": return detailPage(await db.select({
      twitchStreamId: streamActivityBuckets.twitchStreamId, bucketStart: streamActivityBuckets.bucketStart,
      bucketMinutes: streamActivityBuckets.bucketMinutes, viewerCountAvg: streamActivityBuckets.viewerCountAvg,
      viewerCountMax: streamActivityBuckets.viewerCountMax, messageCount: streamActivityBuckets.messageCount,
      activeChatterCount: streamActivityBuckets.activeChatterCount, joinCount: streamActivityBuckets.joinCount,
      partCount: streamActivityBuckets.partCount, eventCounts: streamActivityBuckets.eventCounts
    }).from(streamActivityBuckets).innerJoin(streamSessions, eq(streamActivityBuckets.twitchStreamId, streamSessions.twitchStreamId))
      .where(eq(streamSessions.broadcasterUserId, broadcasterId))
      .orderBy(desc(streamActivityBuckets.bucketStart), desc(streamActivityBuckets.twitchStreamId), desc(streamActivityBuckets.bucketMinutes)).limit(limit).offset(offset), page);
  }
}
