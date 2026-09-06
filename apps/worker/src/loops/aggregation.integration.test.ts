import { loadConfig } from "@twitch-tracker/config";
import { createDb, type DbClient } from "@twitch-tracker/db";
import { DisabledHelixAdapter } from "@twitch-tracker/twitch";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAggregationLoop } from "./aggregation.js";

vi.mock("./common.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./common.js")>(),
  startIntervalLoop: async (input: { run: () => Promise<unknown> }) => { await input.run(); }
}));

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl != null && !new URL(testDatabaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("TEST_DATABASE_URL must name a dedicated test database.");
}
const database = testDatabaseUrl == null ? null : createDb(testDatabaseUrl);

describe.skipIf(database == null)("Aggregation boundaries with PostgreSQL", () => {
  if (database == null) return;
  const { db, pool } = database;
  beforeEach(async () => { await pool.query("truncate table twitch_users, ingestion_runs cascade"); });
  afterAll(async () => { await pool.end(); });

  it.each([
    { name: "keeps complete buckets and UTC days at the rolling cutoff", hours: 48, repaired: true },
    { name: "repairs historical aggregates beyond the rolling window once", hours: 96, repaired: false }
  ])("$name", async ({ hours, repaired }) => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local time zone 'Pacific/Honolulu'`);
      await tx.execute(sql`
        create temporary table fixture_times on commit drop as
        select date_bin(interval '5 minutes', now() - make_interval(hours => ${hours}), timestamptz '1970-01-01') as bucket,
          date_trunc('day', now() - make_interval(hours => ${hours}), 'UTC') as day
      `);
      await tx.execute(sql`insert into twitch_users (twitch_user_id, login) values ('channel', 'channel'), ('chatter', 'chatter')`);
      await tx.execute(sql`
        insert into stream_sessions (twitch_stream_id, broadcaster_user_id, started_at, ended_at, last_seen_live_at)
        select 'stream', 'channel', bucket, bucket + interval '5 minutes', bucket + interval '5 minutes' from fixture_times
        union all select 'early-stream', 'channel', day, day + interval '1 minute', day + interval '1 minute' from fixture_times
      `);
      await tx.execute(sql`
        insert into chat_messages (twitch_message_id, broadcaster_user_id, twitch_stream_id, chatter_user_id, received_at, sent_at)
        select 'first', 'channel', 'stream', 'chatter', bucket, bucket from fixture_times
        union all select 'last', 'channel', 'stream', 'chatter', bucket + interval '5 minutes' - interval '1 microsecond', bucket + interval '5 minutes' - interval '1 microsecond' from fixture_times
        union all select 'early', 'channel', 'early-stream', 'chatter', day, day from fixture_times
      `);
      await tx.execute(sql`
        insert into stream_snapshots (twitch_stream_id, broadcaster_user_id, observed_at, viewer_count)
        select 'stream', 'channel', bucket, 200 from fixture_times
        union all select 'stream', 'channel', bucket + interval '5 minutes' - interval '1 microsecond', 100 from fixture_times
        union all select 'early-stream', 'channel', day, 300 from fixture_times
      `);
      await tx.execute(sql`
        insert into chat_membership_events (broadcaster_user_id, twitch_stream_id, chatter_user_id, event_type, event_at, received_at, dedupe_key)
        select 'channel', 'stream', 'chatter', 'join'::chat_membership_event_type, bucket, bucket, 'join' from fixture_times
        union all select 'channel', 'stream', 'chatter', 'part'::chat_membership_event_type, bucket + interval '5 minutes' - interval '1 microsecond', bucket + interval '5 minutes' - interval '1 microsecond', 'part' from fixture_times
      `);
      await tx.execute(sql`
        insert into channel_events (broadcaster_user_id, twitch_stream_id, event_type, occurred_at, source)
        select 'channel', 'stream', 'test.event', bucket, 'test' from fixture_times
        union all select 'channel', 'stream', 'test.event', bucket + interval '5 minutes' - interval '1 microsecond', 'test' from fixture_times
      `);
      if (repaired) {
        await tx.execute(sql`insert into ingestion_runs (job_type, status) values ('aggregation-boundary-repair-v1', 'succeeded')`);
      } else {
        await tx.execute(sql`
          insert into stream_activity_buckets (twitch_stream_id, bucket_start, bucket_minutes, message_count)
          select 'stream', bucket, 5, 1 from fixture_times
        `);
      }
      const context = {
        config: loadConfig({ DATABASE_URL: testDatabaseUrl, SESSION_SECRET: "s".repeat(48), AGGREGATION_LOOKBACK_HOURS: "48" }),
        db: tx as unknown as DbClient, rest: new DisabledHelixAdapter(), workerName: "test-worker",
        abortSignal: new AbortController().signal
      };
      await runAggregationLoop(context);
      const stream = await tx.execute(sql`select * from stream_activity_buckets where twitch_stream_id = 'stream' and bucket_minutes = 5`);
      expect(stream.rows).toHaveLength(1);
      expect(stream.rows[0]).toMatchObject({
        message_count: 2, active_chatter_count: 1, join_count: 1, part_count: 1,
        viewer_count_min: 100, viewer_count_max: 200, viewer_count_avg: 150,
        event_counts: { "test.event": 2 }
      });
      const channel = await tx.execute(sql`select * from channel_daily_stats where broadcaster_user_id = 'channel'`);
      expect(channel.rows).toHaveLength(1);
      expect(channel.rows[0]).toMatchObject({ stream_count: 2, live_seconds: 360, message_count: 3, viewer_count_max: 300, viewer_count_avg: 200 });
      const chatter = await tx.execute(sql`select * from chatter_channel_activity_buckets where bucket_start = (select bucket from fixture_times) and bucket_minutes = 5`);
      expect(chatter.rows).toHaveLength(1);
      expect(chatter.rows[0]).toMatchObject({ message_count: 2, join_count: 1, part_count: 1, active_minutes: 2 });
      const daily = await tx.execute(sql`select * from chatter_daily_stats`);
      expect(daily.rows).toHaveLength(1);
      expect(daily.rows[0]).toMatchObject({ message_count: 3, channels_active: 1, active_minutes: 3 });

      await runAggregationLoop(context);
      const runs = await tx.execute(sql`select count(*)::int as count from ingestion_runs where job_type = 'aggregation-boundary-repair-v1' and status = 'succeeded'`);
      expect(runs.rows[0]).toMatchObject({ count: 1 });
    });
  });
});
