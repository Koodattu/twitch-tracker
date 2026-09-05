import { channelDailyStats, streamActivityBuckets, streamSessions, streamSnapshots, type DbClient } from "@twitch-tracker/db";
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { detailPage, detailPageNumberSchema, detailPageSize, viewerObservationFields } from "./detail-records.js";

export const channelDetailQuerySchema = z.object({ page: detailPageNumberSchema });

const sessionFields = {
  twitchStreamId: streamSessions.twitchStreamId, latestTitle: streamSessions.latestTitle,
  latestCategoryName: streamSessions.latestCategoryName, startedAt: streamSessions.startedAt,
  endedAt: streamSessions.endedAt, lastSeenLiveAt: streamSessions.lastSeenLiveAt
};
const dailyFields = {
  day: channelDailyStats.day, streamCount: channelDailyStats.streamCount, liveSeconds: channelDailyStats.liveSeconds,
  viewerCountMax: channelDailyStats.viewerCountMax, viewerCountAvg: channelDailyStats.viewerCountAvg,
  messageCount: channelDailyStats.messageCount
};

export async function getChannelOverview(db: DbClient, broadcasterId: string) {
  const toDay = new Date().toISOString().slice(0, 10);
  const fromDay = new Date(Date.parse(toDay) - 29 * 86_400_000).toISOString().slice(0, 10);
  const [daily, recentSessions, liveSessions] = await Promise.all([
    db.select(dailyFields).from(channelDailyStats)
      .where(and(eq(channelDailyStats.broadcasterUserId, broadcasterId), gte(channelDailyStats.day, fromDay), lte(channelDailyStats.day, toDay)))
      .orderBy(channelDailyStats.day),
    db.select(sessionFields).from(streamSessions).where(eq(streamSessions.broadcasterUserId, broadcasterId))
      .orderBy(desc(streamSessions.startedAt), desc(streamSessions.twitchStreamId)).limit(6),
    db.select(sessionFields).from(streamSessions).where(and(eq(streamSessions.broadcasterUserId, broadcasterId), isNull(streamSessions.endedAt)))
      .orderBy(desc(streamSessions.startedAt), desc(streamSessions.twitchStreamId)).limit(1)
  ]);
  const averages = daily.flatMap((day) => day.viewerCountAvg == null ? [] : [day.viewerCountAvg]);
  const peaks = daily.flatMap((day) => day.viewerCountMax == null ? [] : [day.viewerCountMax]);
  return {
    fromDay, toDay, daily, recentSessions, liveSession: liveSessions[0] ?? null,
    totals: daily.length === 0 ? null : {
      streamCount: daily.reduce((total, day) => total + day.streamCount, 0),
      liveSeconds: daily.reduce((total, day) => total + day.liveSeconds, 0),
      messageCount: daily.reduce((total, day) => total + day.messageCount, 0),
      viewerCountMax: peaks.length === 0 ? null : Math.max(...peaks),
      viewerCountAvg: averages.length === 0 ? null : Math.round(averages.reduce((total, count) => total + count, 0) / averages.length)
    }
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
