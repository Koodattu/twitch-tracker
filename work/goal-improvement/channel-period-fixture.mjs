// Bounded synthetic data; this helper never reads inherited database credentials.
import { createRequire } from "node:module";
import { fixtureUrl } from "./fixture.mjs";
const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { Pool } = require("pg");
export const periodChannel = { id: "goal-period-round4", login: "periodreview", name: "PeriodReview · Finnish streams, games and late-night conversations" };
export async function removePeriodFixture() {
  const pool = new Pool({ connectionString: fixtureUrl });
  try {
    for (const table of ["channel_daily_stats", "stream_snapshots", "stream_sessions", "twitch_users"]) {
      await pool.query(`delete from ${table} where ${table === "twitch_users" ? "twitch_user_id" : "broadcaster_user_id"}=$1`, [periodChannel.id]);
    }
  }
  finally { await pool.end(); }
}
export async function seedPeriodFixture() {
  await removePeriodFixture();
  const pool = new Pool({ connectionString: fixtureUrl });
  const end = new Date(Date.parse(new Date().toISOString().slice(0,10)) - 86400000);
  const dayAt = offset => new Date(end.getTime() - offset * 86400000).toISOString().slice(0,10);
  let sessions = 0, samples = 0;
  try {
    await pool.query("insert into twitch_users(twitch_user_id,login,display_name,description) values($1,$2,$3,$4)", [periodChannel.id,periodChannel.login,periodChannel.name,"Synthetic local analytical QA. No real Twitch identity."]);
    for (let index=0; index<95; index++) {
      if (index>0 && index%11===0) continue;
      const day=dayAt(index), stream=`goal-period-${index}`;
      const start=new Date(`${day}T${index%8===0 ? '23:57' : '18:00'}:00Z`), finish=new Date(start.getTime()+1800000);
      await pool.query("insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,first_seen_at,last_seen_live_at,ended_at,language,is_finnish_eligible,finnish_match_reason,latest_title,latest_category_id,latest_category_name) values($1,$2,$3,$3,$4,$4,'fi',true,'language',$5,'period-game','Strategy & building')", [stream,periodChannel.id,start,finish,`Session ${index}: ${index%2 ? 'Building a northern village with a very long title and community challenges' : 'Late-night games and conversation · Yhteisön peli-ilta'}`]);
      sessions++;
      for(let point=0;point<10;point++) {
        if(index%9===0 && [3,4,5].includes(point)) continue;
        await pool.query("insert into stream_snapshots(twitch_stream_id,broadcaster_user_id,observed_at,viewer_count,title,category_id,category_name) values($1,$2,$3,$4,$5,$6,$7)", [stream,periodChannel.id,new Date(start.getTime()+point*180000),index===18?null:index===2?0:100+((index*37+point*29)%1300),point===0?'Starting':point===6?'Chatting':null,point===0?'period-game':point===6?'period-chat':null,point===0?'Strategy & building':point===6?'Just Chatting':null]);
        samples++;
      }
      await pool.query("insert into channel_daily_stats(broadcaster_user_id,day,stream_count,live_seconds,message_count) values($1,$2,1,1800,$3)", [periodChannel.id,day,index===20?0:20+(index*71)%2000]);
    }
    return { endDay:dayAt(0), zeroDay:dayAt(2), missingDay:dayAt(18), emptyDay:dayAt(11), sessions, samples };
  } finally { await pool.end(); }
}
