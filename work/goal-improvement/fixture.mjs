// Synthetic UI data only. Deliberately ignores DATABASE_URL and the user's .env.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { Pool } = require("pg");
const databasePort = Number(process.env.GOAL_DATABASE_PORT ?? 55432);
if (!Number.isInteger(databasePort) || databasePort < 1024 || databasePort > 65535) throw new Error("Invalid local QA database port.");
export const fixtureUrl = `postgres://goal_test:goal_test_local_only@127.0.0.1:${databasePort}/twitch_tracker_goal_ui_test`;
const command = pathToFileURL(resolve(process.argv[1])).href === import.meta.url ? process.argv[2] : undefined;

if (command === "create") {
  const admin = new Pool({ connectionString: fixtureUrl.replace("goal_ui_test", "goal_test") });
  try {
    const exists = await admin.query("select 1 from pg_database where datname='twitch_tracker_goal_ui_test'");
    if (exists.rowCount === 0) await admin.query("create database twitch_tracker_goal_ui_test");
    console.log("Dedicated UI test database ready; apply existing migrations before seeding.");
  } finally { await admin.end(); }
} else if (command === "seed") {
  const pool = new Pool({ connectionString: fixtureUrl });
  try {
    await pool.query("truncate twitch_users, community_map_state, community_map_snapshots cascade");
    const now = Date.now();
    const people = [
      ["goal-aurora", "aurorapelaa", "AuroraPelaa", "Rauhallinen ilta · Building a northern village", "Minecraft"],
      ["goal-sisu", "sisulive", "SisuLive", "Ranked matches with friends — Finnish / English", "Counter-Strike"],
      ["goal-kettu", "kettukahvi", "KettuKahvi", "Kahvia ja kuulumisia ☕", "Just Chatting"],
      ["goal-lumi", "lumistudio", "LumiStudio", "Drawing an autumn forest together", "Art"]
    ];
    for (const [index, [id, login, display, title, category]] of people.entries()) {
      await pool.query("insert into twitch_users(twitch_user_id,login,display_name,description) values($1,$2,$3,$4)", [id, login, display, "Synthetic local QA channel. Finnish-language streams and shared hobbies."]);
      await pool.query("insert into channels(twitch_user_id,has_been_seen_finnish) values($1,true)", [id]);
      for (let day = 0; day < 3; day++) {
        const stream = `${id}-${day}`;
        const start = new Date(now - day * 86400000 - 3600000);
        const end = new Date(start.getTime() + 3600000);
        await pool.query(`insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,first_seen_at,last_seen_live_at,ended_at,
          language,finnish_match_reason,is_finnish_eligible,initial_title,latest_title,latest_category_id,latest_category_name)
          values($1,$2,$3,$3,$4,$5,'fi','language',true,$6,$6,$7,$8)`, [stream,id,start,end,day === 0 ? null : end,title,`goal-category-${index}`,category]);
        for (let sample = 0; sample <= 20; sample++) {
          await pool.query(`insert into stream_snapshots(twitch_stream_id,broadcaster_user_id,observed_at,viewer_count,title,category_id,category_name)
            values($1,$2,$3,$4,$5,$6,$7)`, [stream,id,new Date(start.getTime()+sample*180000),Math.max(0,950-index*180+sample*7),sample===0?title:null,sample===0?`goal-category-${index}`:null,sample===0?category:null]);
          if (sample < 12) await pool.query(`insert into stream_activity_buckets(twitch_stream_id,bucket_start,bucket_minutes,message_count,active_chatter_count,viewer_count_avg,viewer_count_max)
            values($1,$2,5,$3,$4,$5,$6)`, [stream,new Date(start.getTime()+sample*300000),20+sample,7+sample,800-index*100,950-index*100]);
        }
        await pool.query(`insert into channel_daily_stats(broadcaster_user_id,day,stream_count,live_seconds,message_count)
          values($1,$2,1,3600,420) on conflict do nothing`, [id,start.toISOString().slice(0,10)]);
      }
    }
    await pool.query("insert into twitch_users(twitch_user_id,login,display_name) values('goal-chat','testichat','TestiChat')");
    for (let index=0;index<55;index++) {
      await pool.query(`insert into chat_messages(twitch_message_id,broadcaster_user_id,twitch_stream_id,chatter_user_id,chatter_login,raw_text,received_at,sent_at)
        values(encode_chat_message_id($1),'goal-aurora','goal-aurora-0','goal-chat','testichat',$2,$3,$3)`, [`goal-message-${index}`,`Synthetic message ${index+1}: Hyvää iltaa! This village looks lovely.`,new Date(now-index*30000)]);
    }
    const graph = { nodes: people.map(([id],index)=>({id,chatters:30+index*10,participants:45+index*10,community:index<3?"goal-community":null,x:300+index*140,y:index%2?580:400})),edges:[{source:"goal-aurora",target:"goal-sisu",shared:20,score:0.6},{source:"goal-sisu",target:"goal-kettu",shared:15,score:0.4}] };
    const coverage = { firstObservedAt:new Date(now-86400000).toISOString(),lastObservedAt:new Date(now).toISOString(),messages:4000,missingSession:0,unknownSource:0,relayedMessages:0,qualifyingMemberships:240 };
    const snapshot = await pool.query(`insert into community_map_snapshots(recipe,window_start,window_end,privacy_version,graph,coverage)
      values('synthetic-goal-qa',$1,$2,0,$3,$4) returning id`, [new Date(now-30*86400000),new Date(now),graph,coverage]);
    await pool.query("insert into community_map_state(id,status,snapshot_id) values('current','ready',$1)", [snapshot.rows[0].id]);
    console.log("Seeded 4 synthetic channels, 12 sessions, 252 sparse snapshots, 55 messages and a community map.");
  } finally { await pool.end(); }
} else if (command != null) {
  throw new Error("Use create or seed.");
}
