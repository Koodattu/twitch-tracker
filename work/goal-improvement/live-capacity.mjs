// Bounded synthetic capacity scene; the fixture URL cannot point at production.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { fixtureUrl } from "./fixture.mjs";
const { Pool } = createRequire(new URL("../../packages/db/package.json", import.meta.url))("pg");
const pool = new Pool({ connectionString: fixtureUrl });
const prefix = "goal-live-capacity-";
const mode = process.argv[2];
try {
  if (mode === "seed") {
    await pool.query(`insert into twitch_users(twitch_user_id,login,display_name)
      select $1||n,'capacity'||lpad(n::text,3,'0'),'Synthetic Channel '||n from generate_series(1,125) n`, [prefix]);
    await pool.query(`insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,first_seen_at,last_seen_live_at,
      language,finnish_match_reason,is_finnish_eligible,latest_title,latest_category_name)
      select $1||n,$1||n,now()-interval '4 hours',now()-interval '4 hours',
        now()-case when n%5=0 then interval '3 hours' else interval '2 minutes' end,
        'fi','language',true,'Synthetic session '||n||' — '||repeat('Pitkä suomalainen otsikko · ',8),
        case when n%2=0 then 'Just Chatting' else 'Minecraft' end from generate_series(1,125) n`, [prefix]);
    await pool.query(`insert into stream_snapshots(twitch_stream_id,broadcaster_user_id,observed_at,viewer_count)
      select twitch_stream_id,broadcaster_user_id,last_seen_live_at,
        case when right(twitch_stream_id,1)='7' then 0 else 250 end
      from stream_sessions where broadcaster_user_id like $1 and right(twitch_stream_id,1)<>'9'`, [`${prefix}%`]);
    console.log("Added 125 synthetic open sessions: varied freshness, missing samples, zero, and long titles.");
  } else if (mode === "measure") {
    const results = [];
    for (const path of ["http://127.0.0.1:4400/api/streams/live", "http://127.0.0.1:3300/", "http://127.0.0.1:3300/?page=2"]) {
      const durations = [];
      let bytes;
      for (let i = 0; i < 12; i++) {
        const start = performance.now();
        const response = await fetch(path);
        const body = await response.text();
        assert.equal(response.status, 200);
        if (path.includes("/api/")) assert.ok(JSON.parse(body).data.length >= 125);
        else assert.ok(body.includes("Observed viewers"));
        durations.push(performance.now() - start);
        bytes = Buffer.byteLength(body);
      }
      const warm = durations.slice(1).sort((a,b) => a-b);
      results.push({ path: new URL(path).pathname + new URL(path).search, bytes, coldMs: durations[0], medianMs: warm[5], maxMs: warm.at(-1) });
    }
    const report = { workload: "125 additional synthetic open sessions; one cold and 11 warm HTTP requests; local built app", node: process.version, results };
    await writeFile(new URL("./evidence/2026-10-06/live-capacity.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } else if (mode === "cleanup") {
    await pool.query("delete from stream_snapshots where broadcaster_user_id like $1", [`${prefix}%`]);
    await pool.query("delete from stream_sessions where broadcaster_user_id like $1", [`${prefix}%`]);
    await pool.query("delete from twitch_users where twitch_user_id like $1", [`${prefix}%`]);
    console.log("Removed only the synthetic capacity scene.");
  } else throw new Error("Use seed, measure or cleanup.");
} finally { await pool.end(); }
