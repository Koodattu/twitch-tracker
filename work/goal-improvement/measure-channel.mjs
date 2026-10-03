import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { fixtureUrl } from "./fixture.mjs";
const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { Pool } = require("pg");
const label = process.argv[2];
if (label !== "before" && label !== "after") throw new Error("Use before or after.");
if (label === "before") {
  const pool = new Pool({ connectionString: fixtureUrl });
  try {
    await pool.query("insert into twitch_users(twitch_user_id,login) values('goal-bench','goalbench')");
    await pool.query(`insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,ended_at)
      select 'goal-bench-'||day,'goal-bench',date_trunc('day',now())-day*interval '1 day',date_trunc('day',now())-day*interval '1 day'+interval '6 hours'
      from generate_series(1,29) day`);
    await pool.query(`insert into stream_snapshots(twitch_stream_id,broadcaster_user_id,observed_at,viewer_count,title,category_id,category_name)
      select s.twitch_stream_id,'goal-bench',s.started_at+sample*interval '3 minutes',100+sample,
        case when sample in (0,60) then 'Synthetic stream' end,
        case when sample=0 then 'game' when sample=60 then 'chat' end,
        case when sample=0 then 'Game' when sample=60 then 'Just Chatting' end
      from stream_sessions s cross join generate_series(0,120) sample where s.broadcaster_user_id='goal-bench'`);
    await pool.query("analyze stream_sessions");
    await pool.query("analyze stream_snapshots");
  } finally { await pool.end(); }
}
const elapsed = [];
let result, bytes;
for (let run=0;run<16;run++) {
  const start=performance.now();
  const response=await fetch("http://127.0.0.1:4400/api/channels/goalbench/overview");
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  const body=await response.text();
  elapsed.push(Number((performance.now()-start).toFixed(2)));
  result=JSON.parse(body).data;
  bytes=Buffer.byteLength(body);
}
const warm=elapsed.slice(1).sort((a,b)=>a-b);
const report={label,node:process.version,workload:"29 six-hour sessions, 3509 snapshots, category switch halfway; PostgreSQL 16.14, localhost; first request then 15 warm runs",firstMs:elapsed[0],warmMedianMs:warm[7],warmMinMs:warm[0],warmMaxMs:warm[14],bytes,categorySeconds:result.categorySeconds,topCategories:result.topCategories,elapsedMs:elapsed};
await writeFile(new URL(`./evidence/channel-${label}.json`,import.meta.url),JSON.stringify(report,null,2));
console.log(report);
