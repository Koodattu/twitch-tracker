// Bounded synthetic capacity check, not a claim about production performance.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { fixtureUrl } from "./fixture.mjs";
const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { Pool } = require("pg");
const pool = new Pool({ connectionString: fixtureUrl });
const prefix = "directory-perf-";
const results = [];
try {
  await pool.query(`insert into twitch_users(twitch_user_id,login,display_name)
    select $1||n, 'performance'||lpad(n::text,4,'0'), 'Performance Channel '||n from generate_series(1,1000) n`, [prefix]);
  await pool.query(`insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,first_seen_at,last_seen_live_at,ended_at,is_finnish_eligible)
    select $1||n||'-'||s,$1||n,now()-s*interval '1 day',now()-s*interval '1 day',now()-s*interval '1 day'+interval '1 hour',
      now()-s*interval '1 day'+interval '1 hour',true from generate_series(1,1000) n cross join generate_series(1,20) s`, [prefix]);
  await pool.query("analyze twitch_users");
  await pool.query("analyze stream_sessions");
  for (const query of ["", "?q=performance", "?q=performance0999", "?q=performance&page=20"]) {
    const durations = [];
    let bytes = 0;
    let count = 0;
    for (let iteration = 0; iteration < 16; iteration++) {
      const start = performance.now();
      const response = await fetch(`http://127.0.0.1:4400/api/channels${query}`);
      const body = await response.text();
      durations.push(performance.now() - start);
      assert.equal(response.status, 200);
      const data = JSON.parse(body).data;
      count = data.items.length;
      assert.ok(count <= 50);
      if (query.includes("0999")) assert.equal(count, 1);
      if (query.includes("page=20")) { assert.equal(count, 50); assert.equal(data.hasMore, false); }
      bytes = Buffer.byteLength(body);
    }
    const warm = durations.slice(1).sort((a,b) => a-b);
    results.push({ query, rows: count, bytes, coldMs: durations[0], warmMedianMs: warm[7], warmMinMs: warm[0], warmMaxMs: warm.at(-1) });
  }
} finally {
  await pool.query("delete from stream_sessions where broadcaster_user_id like $1", [`${prefix}%`]);
  await pool.query("delete from twitch_users where twitch_user_id like $1", [`${prefix}%`]);
  await pool.end();
}
const report = { workload: "1,000 synthetic Finnish channels, 20,000 ended sessions; one cold plus 15 warm HTTP calls per query", node: process.version, results };
await writeFile(new URL("./evidence/round3/directory-capacity.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
