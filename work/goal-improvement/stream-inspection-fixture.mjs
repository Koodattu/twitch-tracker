import { createRequire } from "node:module";
import { fixtureUrl } from "./fixture.mjs";

const { Pool } = createRequire(new URL("../../packages/db/package.json", import.meta.url))("pg");
export const streamId = "goal-round5-inspection";
export const start = "2026-09-20T10:00:00.000Z";
export const at = "2026-09-20T11:00:00.000Z";
export const pool = new Pool({ connectionString: fixtureUrl });

export async function seed() {
  await cleanup();
  await pool.query(`insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,ended_at,last_seen_live_at,
    language,is_finnish_eligible,latest_title,latest_category_name) values($1,'goal-aurora',$2,'2026-09-20T12:00:00Z',
    '2026-09-20T12:00:00Z','fi',true,'Village building, community challenges and an evening raid — synthetic stream review','Minecraft')`, [streamId,start]);
  for (let i=0;i<24;i++) {
    if (i===8) continue;
    const time = new Date(Date.parse(start)+i*300000);
    const viewers = i===7 ? null : i<12 ? 300+i*18 : 900-(i-12)*20;
    await pool.query(`insert into stream_activity_buckets(twitch_stream_id,bucket_start,bucket_minutes,viewer_count_avg,viewer_count_max,
      message_count,active_chatter_count) values($1,$2,5,$3,$4,$5,$6)`, [streamId,time,viewers,viewers==null?null:viewers+100,i===1?0:i===12?250:20+i,i===5?null:i===1?0:i===12?48:8+i]);
    await pool.query(`insert into stream_snapshots(twitch_stream_id,broadcaster_user_id,observed_at,viewer_count,title,category_id,category_name)
      values($1,'goal-aurora',$2,$3,$4,$5,$6)`, [streamId,time,viewers,i===0?"Building a northern village":null,i===0?"goal-category-0":null,i===0?"Minecraft":null]);
  }
  await pool.query(`insert into channel_events(twitch_stream_id,event_type,occurred_at,source)
    select $1,'channel.update',timestamptz '2026-09-20T11:00:00Z'+make_interval(secs=>i*4),'eventsub' from generate_series(0,54) i`, [streamId]);
  await pool.query(`insert into channel_events(twitch_stream_id,event_type,occurred_at,source) values
    ($1,'stream.online','2026-09-20T10:00:00Z','eventsub'),($1,'stream.offline','2026-09-20T12:00:00Z','eventsub')`, [streamId]);
  await pool.query(`insert into raids(target_stream_id,source_broadcaster_user_id,viewer_count,occurred_at)
    values($1,'goal-lumi',600,'2026-09-20T11:01:00Z')`, [streamId]);
}

export async function cleanup() {
  for (const table of ["channel_events","stream_activity_buckets","stream_snapshots"]) await pool.query(`delete from ${table} where twitch_stream_id=$1`,[streamId]);
  await pool.query("delete from raids where target_stream_id=$1 or source_stream_id=$1", [streamId]);
  await pool.query("delete from stream_sessions where twitch_stream_id=$1", [streamId]);
}
