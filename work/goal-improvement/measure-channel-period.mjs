import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { fixtureUrl } from "./fixture.mjs";
import { seedPeriodFixture, removePeriodFixture, periodChannel } from "./channel-period-fixture.mjs";
const require=createRequire(new URL("../../packages/db/package.json",import.meta.url));
const {Pool}=require("pg");
const pool=new Pool({connectionString:fixtureUrl});
const fixture=await seedPeriodFixture();
const report={fixture,workload:"87 synthetic six-hour sessions across 95 UTC dates; no production data",measurements:[]};
try {
  await pool.query("update stream_sessions set ended_at=started_at+interval '6 hours', last_seen_live_at=started_at+interval '6 hours' where broadcaster_user_id=$1",[periodChannel.id]);
  await pool.query("insert into stream_snapshots(twitch_stream_id,broadcaster_user_id,observed_at,viewer_count) select twitch_stream_id,broadcaster_user_id,started_at+point*interval '3 minutes',100+(point*37)%1500 from stream_sessions cross join generate_series(10,119) point where broadcaster_user_id=$1",[periodChannel.id]);
  report.samples=Number((await pool.query("select count(*) from stream_snapshots where broadcaster_user_id=$1",[periodChannel.id])).rows[0].count);
  for(const days of [30,90]) {
    const times=[];let bytes=0,count=0;
    for(let run=0;run<16;run++) {
      const start=performance.now();
      const response=await fetch(`http://127.0.0.1:4400/api/channels/${periodChannel.login}/overview?days=${days}&end=${fixture.endDay}`);
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const body=await response.text();
      times.push(performance.now()-start);bytes=Buffer.byteLength(body);count=JSON.parse(body).data.daily.length;
    }
    const warm=times.slice(1).sort((a,b)=>a-b);
    report.measurements.push({days,coldMs:times[0],warmMedianMs:warm[7],warmMinMs:warm[0],warmMaxMs:warm.at(-1),bytes,dailyRecords:count});
  }
  await writeFile(new URL("./evidence/round4/period-capacity.json",import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
} finally {await pool.end();await removePeriodFixture();}
