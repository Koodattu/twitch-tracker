import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { streamId, pool, seed, cleanup } from "./stream-inspection-fixture.mjs";

await seed();
const results = [];
try {
  await pool.query(`insert into channel_events(twitch_stream_id,event_type,occurred_at,source)
    select $1,'channel.update',timestamptz '2026-09-20T10:00:00Z'+make_interval(secs=>i),'eventsub'
    from generate_series(0,5999) i`, [streamId]);
  const prefix = `http://127.0.0.1:4400/api/streams/${streamId}`;
  for (const [label, path] of [
    ["overview", "/overview"], ["all-events", "/events"],
    ["selected-interval", "/events?from=2026-09-20T11%3A00%3A00Z&to=2026-09-20T11%3A05%3A00Z"]
  ]) {
    const timings = [];
    let bytes = 0;
    let items = 0;
    for (let i = 0; i < 16; i++) {
      const start = performance.now();
      const response = await fetch(`${prefix}${path}`);
      const body = await response.text();
      timings.push(performance.now() - start);
      assert.equal(response.status, 200);
      const data = JSON.parse(body).data;
      bytes = Buffer.byteLength(body);
      items = label === "overview" ? data.points.length : data.items.length;
      assert.ok(items <= (label === "overview" ? 300 : 50));
      if (label === "selected-interval") assert.ok(data.items.every(event => Date.parse(event.occurredAt) >= Date.parse("2026-09-20T11:00:00Z") && Date.parse(event.occurredAt) < Date.parse("2026-09-20T11:05:00Z")));
    }
    const warm = timings.slice(1).sort((a, b) => a - b);
    results.push({ label, firstRequestMs: timings[0], warmMedianMs: warm[7], warmP95Ms: warm[14], bytes, items });
  }
  const report = { environment: "Windows Node 24.19, localhost HTTP, dedicated PostgreSQL 16.14 Docker (2 CPUs, 1GiB), synthetic only", workload: { activityBuckets: 23, chartIntervals: 24, channelEvents: 6057, raids: 1 }, iterations: "1 first request + 15 warm per endpoint", results, conclusion: "Capacity measurement; no before/after speed or production performance claim." };
  await writeFile(new URL("./evidence/round5/stream-capacity.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { await cleanup(); await pool.end(); }
