import { sql } from "drizzle-orm";
import type { WorkerContext } from "../worker.js";
import { startIntervalLoop } from "./common.js";

export const runAggregationLoop = (context: WorkerContext) => {
  startIntervalLoop({
    name: "aggregation",
    intervalMs: context.config.AGGREGATION_INTERVAL_MS,
    context,
    run: async () => {
      const bucketMinutes = Math.max(1, context.config.AGGREGATION_BUCKET_MINUTES);
      const lookbackHours = Math.max(1, context.config.AGGREGATION_LOOKBACK_HOURS);

      await rollupStreamViewerBuckets(context, bucketMinutes, lookbackHours);
      await rollupStreamMessageBuckets(context, bucketMinutes, lookbackHours);
      await rollupStreamMembershipBuckets(context, bucketMinutes, lookbackHours);
      await rollupStreamEventBuckets(context, bucketMinutes, lookbackHours);
      await rollupChannelDailyStreams(context, lookbackHours);
      await rollupChannelDailyViewers(context, lookbackHours);
      await rollupChannelDailyMessages(context, lookbackHours);
      await rollupChatterChannelMessageBuckets(context, bucketMinutes, lookbackHours);
      await rollupChatterChannelMembershipBuckets(context, bucketMinutes, lookbackHours);
      await rollupChatterDaily(context, lookbackHours);

      return {
        bucketMinutes,
        lookbackHours,
        rollupsExecuted: 10
      };
    }
  });
};

const rollupStreamViewerBuckets = async (context: WorkerContext, bucketMinutes: number, lookbackHours: number) => {
  await context.db.execute(sql`
    insert into stream_activity_buckets (
      twitch_stream_id,
      bucket_start,
      bucket_minutes,
      viewer_count_min,
      viewer_count_max,
      viewer_count_avg,
      updated_at
    )
    select
      twitch_stream_id,
      date_bin(make_interval(mins => ${bucketMinutes}), observed_at, timestamptz '1970-01-01') as bucket_start,
      ${bucketMinutes} as bucket_minutes,
      min(viewer_count)::int as viewer_count_min,
      max(viewer_count)::int as viewer_count_max,
      round(avg(viewer_count))::int as viewer_count_avg,
      now() as updated_at
    from stream_snapshots
    where observed_at >= now() - make_interval(hours => ${lookbackHours})
      and viewer_count is not null
    group by twitch_stream_id, bucket_start
    on conflict (twitch_stream_id, bucket_start, bucket_minutes) do update set
      viewer_count_min = excluded.viewer_count_min,
      viewer_count_max = excluded.viewer_count_max,
      viewer_count_avg = excluded.viewer_count_avg,
      updated_at = now()
  `);
};

const rollupStreamMessageBuckets = async (context: WorkerContext, bucketMinutes: number, lookbackHours: number) => {
  await context.db.execute(sql`
    insert into stream_activity_buckets (
      twitch_stream_id,
      bucket_start,
      bucket_minutes,
      message_count,
      active_chatter_count,
      updated_at
    )
    select
      twitch_stream_id,
      date_bin(make_interval(mins => ${bucketMinutes}), coalesce(sent_at, received_at), timestamptz '1970-01-01') as bucket_start,
      ${bucketMinutes} as bucket_minutes,
      count(*)::int as message_count,
      count(distinct chatter_user_id)::int as active_chatter_count,
      now() as updated_at
    from chat_messages
    where twitch_stream_id is not null
      and coalesce(sent_at, received_at) >= now() - make_interval(hours => ${lookbackHours})
    group by twitch_stream_id, bucket_start
    on conflict (twitch_stream_id, bucket_start, bucket_minutes) do update set
      message_count = excluded.message_count,
      active_chatter_count = excluded.active_chatter_count,
      updated_at = now()
  `);
};

const rollupStreamMembershipBuckets = async (context: WorkerContext, bucketMinutes: number, lookbackHours: number) => {
  await context.db.execute(sql`
    insert into stream_activity_buckets (
      twitch_stream_id,
      bucket_start,
      bucket_minutes,
      join_count,
      part_count,
      updated_at
    )
    select
      twitch_stream_id,
      date_bin(make_interval(mins => ${bucketMinutes}), coalesce(event_at, received_at), timestamptz '1970-01-01') as bucket_start,
      ${bucketMinutes} as bucket_minutes,
      count(*) filter (where event_type = 'join')::int as join_count,
      count(*) filter (where event_type = 'part')::int as part_count,
      now() as updated_at
    from chat_membership_events
    where twitch_stream_id is not null
      and coalesce(event_at, received_at) >= now() - make_interval(hours => ${lookbackHours})
    group by twitch_stream_id, bucket_start
    on conflict (twitch_stream_id, bucket_start, bucket_minutes) do update set
      join_count = excluded.join_count,
      part_count = excluded.part_count,
      updated_at = now()
  `);
};

const rollupStreamEventBuckets = async (context: WorkerContext, bucketMinutes: number, lookbackHours: number) => {
  await context.db.execute(sql`
    with event_counts as (
      select
        twitch_stream_id,
        date_bin(make_interval(mins => ${bucketMinutes}), occurred_at, timestamptz '1970-01-01') as bucket_start,
        event_type,
        count(*)::int as event_count
      from channel_events
      where twitch_stream_id is not null
        and occurred_at >= now() - make_interval(hours => ${lookbackHours})
      group by twitch_stream_id, bucket_start, event_type
    )
    insert into stream_activity_buckets (
      twitch_stream_id,
      bucket_start,
      bucket_minutes,
      event_counts,
      updated_at
    )
    select
      twitch_stream_id,
      bucket_start,
      ${bucketMinutes} as bucket_minutes,
      jsonb_object_agg(event_type, event_count) as event_counts,
      now() as updated_at
    from event_counts
    group by twitch_stream_id, bucket_start
    on conflict (twitch_stream_id, bucket_start, bucket_minutes) do update set
      event_counts = excluded.event_counts,
      updated_at = now()
  `);
};

const rollupChannelDailyStreams = async (context: WorkerContext, lookbackHours: number) => {
  await context.db.execute(sql`
    insert into channel_daily_stats (
      broadcaster_user_id,
      day,
      stream_count,
      live_seconds,
      updated_at
    )
    select
      broadcaster_user_id,
      to_char(started_at at time zone 'UTC', 'YYYY-MM-DD') as day,
      count(*)::int as stream_count,
      sum(greatest(0, extract(epoch from (coalesce(ended_at, last_seen_live_at, started_at) - started_at))))::int as live_seconds,
      now() as updated_at
    from stream_sessions
    where started_at >= now() - make_interval(hours => ${lookbackHours})
    group by broadcaster_user_id, day
    on conflict (broadcaster_user_id, day) do update set
      stream_count = excluded.stream_count,
      live_seconds = excluded.live_seconds,
      updated_at = now()
  `);
};

const rollupChannelDailyViewers = async (context: WorkerContext, lookbackHours: number) => {
  await context.db.execute(sql`
    insert into channel_daily_stats (
      broadcaster_user_id,
      day,
      stream_count,
      live_seconds,
      viewer_count_max,
      viewer_count_avg,
      updated_at
    )
    select
      broadcaster_user_id,
      to_char(observed_at at time zone 'UTC', 'YYYY-MM-DD') as day,
      0 as stream_count,
      0 as live_seconds,
      max(viewer_count)::int as viewer_count_max,
      round(avg(viewer_count))::int as viewer_count_avg,
      now() as updated_at
    from stream_snapshots
    where observed_at >= now() - make_interval(hours => ${lookbackHours})
      and viewer_count is not null
    group by broadcaster_user_id, day
    on conflict (broadcaster_user_id, day) do update set
      viewer_count_max = excluded.viewer_count_max,
      viewer_count_avg = excluded.viewer_count_avg,
      updated_at = now()
  `);
};

const rollupChannelDailyMessages = async (context: WorkerContext, lookbackHours: number) => {
  await context.db.execute(sql`
    insert into channel_daily_stats (
      broadcaster_user_id,
      day,
      stream_count,
      live_seconds,
      message_count,
      updated_at
    )
    select
      broadcaster_user_id,
      to_char(received_at at time zone 'UTC', 'YYYY-MM-DD') as day,
      0 as stream_count,
      0 as live_seconds,
      count(*)::int as message_count,
      now() as updated_at
    from chat_messages
    where received_at >= now() - make_interval(hours => ${lookbackHours})
    group by broadcaster_user_id, day
    on conflict (broadcaster_user_id, day) do update set
      message_count = excluded.message_count,
      updated_at = now()
  `);
};

const rollupChatterChannelMessageBuckets = async (context: WorkerContext, bucketMinutes: number, lookbackHours: number) => {
  await context.db.execute(sql`
    insert into chatter_channel_activity_buckets (
      chatter_user_id,
      broadcaster_user_id,
      bucket_start,
      bucket_minutes,
      message_count,
      first_activity_at,
      last_activity_at,
      active_minutes,
      updated_at
    )
    select
      chatter_user_id,
      broadcaster_user_id,
      date_bin(make_interval(mins => ${bucketMinutes}), coalesce(sent_at, received_at), timestamptz '1970-01-01') as bucket_start,
      ${bucketMinutes} as bucket_minutes,
      count(*)::int as message_count,
      min(coalesce(sent_at, received_at)) as first_activity_at,
      max(coalesce(sent_at, received_at)) as last_activity_at,
      count(distinct date_trunc('minute', coalesce(sent_at, received_at)))::int as active_minutes,
      now() as updated_at
    from chat_messages
    where chatter_user_id is not null
      and coalesce(sent_at, received_at) >= now() - make_interval(hours => ${lookbackHours})
    group by chatter_user_id, broadcaster_user_id, bucket_start
    on conflict (chatter_user_id, broadcaster_user_id, bucket_start, bucket_minutes) do update set
      message_count = excluded.message_count,
      first_activity_at = excluded.first_activity_at,
      last_activity_at = excluded.last_activity_at,
      active_minutes = excluded.active_minutes,
      updated_at = now()
  `);
};

const rollupChatterChannelMembershipBuckets = async (context: WorkerContext, bucketMinutes: number, lookbackHours: number) => {
  await context.db.execute(sql`
    insert into chatter_channel_activity_buckets (
      chatter_user_id,
      broadcaster_user_id,
      bucket_start,
      bucket_minutes,
      join_count,
      part_count,
      first_activity_at,
      last_activity_at,
      updated_at
    )
    select
      chatter_user_id,
      broadcaster_user_id,
      date_bin(make_interval(mins => ${bucketMinutes}), coalesce(event_at, received_at), timestamptz '1970-01-01') as bucket_start,
      ${bucketMinutes} as bucket_minutes,
      count(*) filter (where event_type = 'join')::int as join_count,
      count(*) filter (where event_type = 'part')::int as part_count,
      min(coalesce(event_at, received_at)) as first_activity_at,
      max(coalesce(event_at, received_at)) as last_activity_at,
      now() as updated_at
    from chat_membership_events
    where chatter_user_id is not null
      and coalesce(event_at, received_at) >= now() - make_interval(hours => ${lookbackHours})
    group by chatter_user_id, broadcaster_user_id, bucket_start
    on conflict (chatter_user_id, broadcaster_user_id, bucket_start, bucket_minutes) do update set
      join_count = excluded.join_count,
      part_count = excluded.part_count,
      first_activity_at = least(
        coalesce(chatter_channel_activity_buckets.first_activity_at, excluded.first_activity_at),
        excluded.first_activity_at
      ),
      last_activity_at = greatest(
        coalesce(chatter_channel_activity_buckets.last_activity_at, excluded.last_activity_at),
        excluded.last_activity_at
      ),
      updated_at = now()
  `);
};

const rollupChatterDaily = async (context: WorkerContext, lookbackHours: number) => {
  await context.db.execute(sql`
    insert into chatter_daily_stats (
      chatter_user_id,
      day,
      message_count,
      channels_active,
      active_minutes,
      summary,
      updated_at
    )
    select
      chatter_user_id,
      to_char(received_at at time zone 'UTC', 'YYYY-MM-DD') as day,
      count(*)::int as message_count,
      count(distinct broadcaster_user_id)::int as channels_active,
      count(distinct date_trunc('minute', received_at))::int as active_minutes,
      jsonb_build_object('source', 'chat_messages') as summary,
      now() as updated_at
    from chat_messages
    where chatter_user_id is not null
      and received_at >= now() - make_interval(hours => ${lookbackHours})
    group by chatter_user_id, day
    on conflict (chatter_user_id, day) do update set
      message_count = excluded.message_count,
      channels_active = excluded.channels_active,
      active_minutes = excluded.active_minutes,
      summary = excluded.summary,
      updated_at = now()
  `);
};
