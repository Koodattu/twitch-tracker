import { channelDailyStats, streamActivityBuckets, streamSessions, streamSnapshots, type DbClient } from "@twitch-tracker/db";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { earliestChannelPeriodEnd, isChannelDay } from "@twitch-tracker/shared";
import { detailPage, detailPageNumberSchema, detailPageSize, viewerObservationFields } from "./detail-records.js";
import { summarizeChannelPeriod } from "./channel-period.js";

export const channelDetailQuerySchema = z.object({
  page: detailPageNumberSchema,
  day: z.string().refine((value) => isChannelDay(value)).optional()
});
export const channelOverviewQuerySchema = z.object({
  days: z.enum(["7", "30", "90"]).default("30").transform(Number),
  end: z.string().refine((value) => isChannelDay(value) && value >= earliestChannelPeriodEnd).optional()
});

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

export async function getChannelOverview(db: DbClient, broadcasterId: string, maxGapSeconds = 360, period: { days: number; end?: string | undefined } = { days: 30 }) {
  const now = new Date();
  const toDay = period.end ?? now.toISOString().slice(0, 10);
  const fromDay = new Date(Date.parse(toDay) - (period.days - 1) * 86_400_000).toISOString().slice(0, 10);
  const from = new Date(fromDay);
  const to = new Date(Math.min(now.getTime(), Date.parse(toDay) + 86_400_000));
  const sampleStart = new Date(from.getTime() - maxGapSeconds * 1000);
  const [daily, recentSessions, liveSessions, periodSessions, samples] = await Promise.all([
    db.select(dailyFields).from(channelDailyStats)
      .where(and(eq(channelDailyStats.broadcasterUserId, broadcasterId), gte(channelDailyStats.day, fromDay), lte(channelDailyStats.day, toDay)))
      .orderBy(channelDailyStats.day),
    db.select(sessionFields).from(streamSessions).where(eq(streamSessions.broadcasterUserId, broadcasterId))
      .orderBy(desc(streamSessions.startedAt), desc(streamSessions.twitchStreamId)).limit(6),
    db.select(sessionFields).from(streamSessions).where(and(eq(streamSessions.broadcasterUserId, broadcasterId), isNull(streamSessions.endedAt)))
      .orderBy(desc(streamSessions.startedAt), desc(streamSessions.twitchStreamId)).limit(1),
    db.select(sessionFields).from(streamSessions).where(and(eq(streamSessions.broadcasterUserId, broadcasterId),
      lt(streamSessions.startedAt, to), gte(sql`coalesce(${streamSessions.endedAt}, ${streamSessions.lastSeenLiveAt})`, from))),
    db.select({ twitchStreamId: streamSnapshots.twitchStreamId, observedAt: streamSnapshots.observedAt,
      viewerCount: streamSnapshots.viewerCount, title: streamSnapshots.title,
      categoryId: streamSnapshots.categoryId, categoryName: streamSnapshots.categoryName })
      .from(streamSnapshots).where(and(eq(streamSnapshots.broadcasterUserId, broadcasterId),
        gte(streamSnapshots.observedAt, sampleStart), lt(streamSnapshots.observedAt, to)))
      .orderBy(asc(streamSnapshots.twitchStreamId), asc(streamSnapshots.observedAt), asc(streamSnapshots.id))
  ]);
  // Metadata is stored only on change. Seed each overlapping session once so a
  // category set before the chart window still applies to its sparse samples.
  const categorySeeds = periodSessions.length === 0 ? [] : await db.selectDistinctOn([streamSnapshots.twitchStreamId], {
    twitchStreamId: streamSnapshots.twitchStreamId,
    categoryId: streamSnapshots.categoryId, categoryName: streamSnapshots.categoryName
  }).from(streamSnapshots).where(and(
    inArray(streamSnapshots.twitchStreamId, periodSessions.map((session) => session.twitchStreamId)),
    lt(streamSnapshots.observedAt, sampleStart), isNotNull(streamSnapshots.title)
  )).orderBy(streamSnapshots.twitchStreamId, desc(streamSnapshots.observedAt), desc(streamSnapshots.id));
  const categories = new Map(categorySeeds.map((seed) => [seed.twitchStreamId, seed]));
  const resolvedSamples = samples.map((sample) => {
    // A title marks a full observation, including an explicit category removal.
    // Category-only legacy rows also remain usable without changing their meaning.
    if (sample.title != null || sample.categoryId != null || sample.categoryName != null) categories.set(sample.twitchStreamId, sample);
    const category = categories.get(sample.twitchStreamId);
    return { ...sample, categoryId: category?.categoryId ?? null, categoryName: category?.categoryName ?? null };
  });
  return {
    fromDay, toDay, asOf: now.toISOString(), recentSessions, liveSession: liveSessions[0] ?? null,
    ...summarizeChannelPeriod({ from, to, maxGapSeconds, sessions: periodSessions, samples: resolvedSamples, messages: daily })
  };
}

export async function getChannelDetail(db: DbClient, broadcasterId: string, kind: "sessions" | "daily" | "observations" | "buckets", page: number, day?: string) {
  const limit = detailPageSize + 1;
  const offset = (page - 1) * detailPageSize;
  switch (kind) {
    case "sessions": return detailPage(await db.select(sessionFields).from(streamSessions)
      .where(and(eq(streamSessions.broadcasterUserId, broadcasterId), day == null ? undefined : and(
        lt(streamSessions.startedAt, new Date(Date.parse(day) + 86_400_000)),
        or(gte(streamSessions.startedAt, new Date(day)), gt(sql`coalesce(${streamSessions.endedAt}, ${streamSessions.lastSeenLiveAt})`, new Date(day)))
      )))
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
    }).from(streamActivityBuckets).innerJoin(streamSessions, eq(streamActivityBuckets.twitchStreamId, streamSessions.storageKey))
      .where(eq(streamSessions.broadcasterUserId, broadcasterId))
      .orderBy(desc(streamActivityBuckets.bucketStart), desc(streamSessions.twitchStreamId), desc(streamActivityBuckets.bucketMinutes)).limit(limit).offset(offset), page);
  }
}
