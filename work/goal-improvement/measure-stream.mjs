// Bounded synthetic benchmark. Uses the same dedicated localhost fixture DB.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fixtureUrl } from "./fixture.mjs";
const { Pool } = createRequire(new URL("../../packages/db/package.json", import.meta.url))("pg");
const pool = new Pool({ connectionString: fixtureUrl });
const phase = process.argv[2];
assert.ok(["before", "after"].includes(phase));
try {
  if (phase === "before") {
    await pool.query("insert into twitch_users(twitch_user_id,login,display_name) values('goal-r2-measure','r2measure','Synthetic stream average benchmark') on conflict do nothing");
    await pool.query(`insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,ended_at,last_seen_live_at)
      values('goal-r2-measure','goal-r2-measure','2026-10-01T00:00:00Z','2026-10-01T18:00:00Z','2026-10-01T18:00:00Z') on conflict do nothing`);
    await pool.query(`insert into stream_activity_buckets(twitch_stream_id,bucket_start,bucket_minutes,viewer_count_avg,viewer_count_max,message_count,active_chatter_count)
      select 'goal-r2-measure',timestamptz '2026-10-01T00:00:00Z'+make_interval(mins=>i*6+j),
        case when j=0 then 1 else 5 end,case when j=0 then 100 else 10 end,case when j=0 then 120 else 12 end,
        case when j=0 then 10 else 50 end,case when j=0 then 1 else 2 end
      from generate_series(0,179) i cross join generate_series(0,1) j on conflict do nothing`);
  }
  const times = [];
  let body, bytes;
  for (let sample = 0; sample < 16; sample++) {
    const start = performance.now();
    const response = await fetch("http://127.0.0.1:4400/api/streams/goal-r2-measure/overview");
    const text = await response.text();
    times.push(performance.now() - start);
    assert.equal(response.status, 200);
    body = JSON.parse(text).data;
    bytes = Buffer.byteLength(text);
  }
  assert.equal(body.totals.viewerCountAvg, phase === "before" ? 55 : 25, "The running API must match the measured source version");
  assert.equal(body.totals.messageCount, 10_800);
  const sorted = times.slice(1).sort((a,b)=>a-b);
  const result = { phase, workload: "360 non-overlapping activity buckets (alternating 1/5 minutes), 18-hour synthetic session", node: process.version,
    coldMs: times[0], warmMedianMs: sorted[7], warmMinMs: sorted[0], warmMaxMs: sorted.at(-1), warmMs: times.slice(1),
    bytes, points: body.points.length, totals: body.totals };
  const evidence = new URL("./evidence/round2/", import.meta.url);
  await mkdir(evidence, { recursive: true });
  await writeFile(new URL(`stream-${phase}.json`, evidence), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
