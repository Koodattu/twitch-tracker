import { chatMembershipEvents, chatMessages, chatPresenceSnapshots, streamActivityBuckets, streamSnapshots, twitchUsers, type DbClient } from "@twitch-tracker/db";
import type { StreamEvent, StreamOverview } from "@twitch-tracker/shared";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { detailPage as streamDetailPage, detailPageNumberSchema, detailPageSize as pageSize, viewerObservationFields } from "./detail-records.js";

export const streamDetailQuerySchema = z.object({
  page: detailPageNumberSchema,
  chatter: z.string().trim().max(100).default(""),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional()
}).refine((query) => query.from == null || query.to == null || new Date(query.from) < new Date(query.to), {
  message: "The end time must be after the start time."
});

export async function getStreamEvents(db: DbClient, streamId: string, limit: number, offset = 0) {
  const result = await db.execute<StreamEvent>(sql`
    select id, event_type as "eventType", occurred_at as "occurredAt", source, actor, viewer_count as "viewerCount"
    from (
      select 'event:' || e.id as id, e.event_type, e.occurred_at, e.source,
        coalesce(u.display_name, u.login, e.actor_user_id) as actor, null::int as viewer_count
      from channel_events e
      left join twitch_users u on u.twitch_user_id = e.actor_user_id
      where e.twitch_stream_id = ${streamId}
        and not exists (
          select 1 from raids r where r.raw_eventsub_event_id = e.raw_eventsub_event_id
            and (r.source_stream_id = ${streamId} or r.target_stream_id = ${streamId})
        )
      union all
      select 'raid:' || r.id, case when r.target_stream_id = ${streamId} then 'incoming_raid' else 'outgoing_raid' end,
        r.occurred_at, 'eventsub', coalesce(u.display_name, u.login, case when r.target_stream_id = ${streamId}
          then r.source_broadcaster_user_id else r.target_broadcaster_user_id end), r.viewer_count
      from raids r
      left join twitch_users u on u.twitch_user_id = case when r.target_stream_id = ${streamId}
        then r.source_broadcaster_user_id else r.target_broadcaster_user_id end
      where r.source_stream_id = ${streamId} or r.target_stream_id = ${streamId}
    ) events
    order by occurred_at desc, id desc
    limit ${limit} offset ${offset}
  `);
  return result.rows;
}

export async function getStreamOverview(db: DbClient, streamId: string): Promise<StreamOverview> {
  const [result, events] = await Promise.all([
    db.execute<{ data: Omit<StreamOverview, "events"> }>(sql`
      with source as (
        select *, lag(bucket_start + make_interval(mins => bucket_minutes)) over (order by bucket_start, bucket_minutes) as previous_end
        from stream_activity_buckets where twitch_stream_id = ${streamId}
      ), bounds as (
        select min(bucket_start) as first_at, max(bucket_start) as last_at,
          greatest(coalesce(max(bucket_minutes), 1), ceil(extract(epoch from (max(bucket_start) - min(bucket_start))) / 60 / 299)::int) as minutes
        from source
      ), grouped as (
        select date_bin(make_interval(mins => bounds.minutes), bucket_start, bounds.first_at) as time,
          round(avg(viewer_count_avg))::int as viewers, max(viewer_count_max) as viewer_peak,
          round(sum(message_count)::numeric / nullif(sum(bucket_minutes) filter (where active_chatter_count is not null), 0), 2) as messages_per_minute,
          max(active_chatter_count) as active_chatters,
          bool_or(bucket_start > previous_end) or count(viewer_count_avg) < count(*) as interrupted
        from source cross join bounds group by time
      ), points as (
        select time, viewers, viewer_peak, messages_per_minute, active_chatters, coalesce(interrupted, true) as interrupted
        from bounds cross join lateral generate_series(first_at, last_at, make_interval(mins => minutes)) as grid(time)
        left join grouped using (time)
      )
      select json_build_object(
        'totals', (select json_build_object(
          'viewerCountAvg', round(avg(viewer_count_avg))::int,
          'viewerCountMax', max(viewer_count_max),
          'messageCount', coalesce(sum(message_count), 0),
          'activeChatterCountMax', max(active_chatter_count)
        ) from source),
        'intervalMinutes', (select minutes from bounds),
        'points', coalesce((select json_agg(json_build_object(
          'time', time, 'viewers', viewers, 'viewerPeak', viewer_peak,
          'messagesPerMinute', messages_per_minute, 'activeChatters', active_chatters, 'interrupted', interrupted
        ) order by time) from points), '[]'::json),
        'peakAudience', (select json_build_object('time', bucket_start, 'viewers', viewer_count_max)
          from source where viewer_count_max is not null order by viewer_count_max desc, bucket_start limit 1),
        'busiestChat', (select json_build_object('time', bucket_start, 'messages', message_count, 'minutes', bucket_minutes)
          from source where message_count > 0 order by message_count::numeric / bucket_minutes desc, bucket_start limit 1),
        'largestRaid', (select json_build_object('time', occurred_at, 'viewers', viewer_count)
          from raids where target_stream_id = ${streamId} and viewer_count is not null order by viewer_count desc, occurred_at limit 1)
      ) as data
    `),
    getStreamEvents(db, streamId, 5)
  ]);
  return { ...result.rows[0]!.data, events };
}

export async function getStreamDetail(db: DbClient, streamId: string, kind: "observations" | "buckets" | "events" | "messages" | "membership" | "presence", query: z.infer<typeof streamDetailQuerySchema>) {
  const limit = pageSize + 1;
  const offset = (query.page - 1) * pageSize;
  switch (kind) {
    case "events": return streamDetailPage(await getStreamEvents(db, streamId, limit, offset), query.page);
    case "observations": return streamDetailPage(await db.select(viewerObservationFields).from(streamSnapshots).where(eq(streamSnapshots.twitchStreamId, streamId))
      .orderBy(desc(streamSnapshots.observedAt), desc(streamSnapshots.id)).limit(limit).offset(offset), query.page);
    case "buckets": return streamDetailPage(await db.select({
      bucketStart: streamActivityBuckets.bucketStart, bucketMinutes: streamActivityBuckets.bucketMinutes,
      viewerCountAvg: streamActivityBuckets.viewerCountAvg, viewerCountMax: streamActivityBuckets.viewerCountMax,
      messageCount: streamActivityBuckets.messageCount, activeChatterCount: streamActivityBuckets.activeChatterCount,
      joinCount: streamActivityBuckets.joinCount, partCount: streamActivityBuckets.partCount, eventCounts: streamActivityBuckets.eventCounts
    }).from(streamActivityBuckets).where(eq(streamActivityBuckets.twitchStreamId, streamId))
      .orderBy(desc(streamActivityBuckets.bucketStart), desc(streamActivityBuckets.bucketMinutes)).limit(limit).offset(offset), query.page);
    case "messages": return streamDetailPage(await db.select({
      messageId: chatMessages.twitchMessageId, chatterLogin: chatMessages.chatterLogin,
      chatterDisplayName: twitchUsers.displayName, sentAt: chatMessages.sentAt, receivedAt: chatMessages.receivedAt,
      rawText: chatMessages.rawText, source: chatMessages.source, messageType: chatMessages.messageType
    }).from(chatMessages).leftJoin(twitchUsers, eq(chatMessages.chatterUserId, twitchUsers.twitchUserId))
      .where(and(eq(chatMessages.twitchStreamId, streamId),
        query.chatter === "" ? undefined : eq(sql`lower(${chatMessages.chatterLogin})`, query.chatter.toLowerCase()),
        query.from == null ? undefined : gte(chatMessages.receivedAt, new Date(query.from)),
        query.to == null ? undefined : lt(chatMessages.receivedAt, new Date(query.to))))
      .orderBy(desc(chatMessages.receivedAt), desc(chatMessages.twitchMessageId)).limit(limit).offset(offset), query.page);
    case "membership": return streamDetailPage(await db.select({
      id: chatMembershipEvents.id, eventType: chatMembershipEvents.eventType, source: chatMembershipEvents.source,
      confidence: chatMembershipEvents.confidence, chatterLogin: chatMembershipEvents.chatterLogin,
      eventAt: chatMembershipEvents.eventAt, receivedAt: chatMembershipEvents.receivedAt
    }).from(chatMembershipEvents).where(eq(chatMembershipEvents.twitchStreamId, streamId))
      .orderBy(desc(chatMembershipEvents.receivedAt), desc(chatMembershipEvents.id)).limit(limit).offset(offset), query.page);
    case "presence": return streamDetailPage(await db.select({
      id: chatPresenceSnapshots.id, source: chatPresenceSnapshots.source, confidence: chatPresenceSnapshots.confidence,
      sampledAt: chatPresenceSnapshots.sampledAt, chatterCount: chatPresenceSnapshots.chatterCount,
      pageCount: chatPresenceSnapshots.pageCount, requestStatus: chatPresenceSnapshots.requestStatus
    }).from(chatPresenceSnapshots).where(eq(chatPresenceSnapshots.twitchStreamId, streamId))
      .orderBy(desc(chatPresenceSnapshots.sampledAt), desc(chatPresenceSnapshots.id)).limit(limit).offset(offset), query.page);
  }
}
