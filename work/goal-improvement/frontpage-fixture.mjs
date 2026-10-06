// Long-title and offline-search checks, confined to the disposable UI database.
import { createRequire } from "node:module";
import { fixtureUrl } from "./fixture.mjs";
const { Pool } = createRequire(new URL("../../packages/db/package.json", import.meta.url))("pg");
const pool = new Pool({ connectionString: fixtureUrl });
try {
  const titles = [
    "Rakennetaan pohjoinen kylä yhdessä 🏡 Pitkä ilta, uusia rakennuksia ja rauhallista jutustelua — tervetuloa mukaan!",
    "Illan viimeiset ranked-pelit kavereiden kanssa 🎮 Tänään opetellaan uusi kartta ja kokeillaan yhteistä taktiikkaa!",
    "Kahvia ja kuulumisia ☕ Mitä teidän viikkoonne kuuluu?",
    "Piirretään syksyinen metsä 🍂 #" + "syksyinenmetsä".repeat(6)
  ];
  for (const [index, identity] of ["aurora", "sisu", "kettu", "lumi"].entries()) {
    await pool.query("update stream_sessions set latest_title=$2 where twitch_stream_id=$1", [`goal-${identity}-0`, titles[index]]);
  }
  await pool.query(`insert into twitch_users(twitch_user_id,login,display_name) values('goal-offline','iltanuotio','Iltanuotio')
    on conflict(twitch_user_id) do nothing`);
  await pool.query(`insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,first_seen_at,last_seen_live_at,ended_at,
    language,finnish_match_reason,is_finnish_eligible,latest_title,latest_category_name)
    values('goal-offline-session','goal-offline',now()-interval '2 days',now()-interval '2 days',now()-interval '47 hours',now()-interval '47 hours',
    'fi','language',true,'Retkellä revontulten alla','Travel & Outdoors') on conflict(twitch_stream_id) do nothing`);
  console.log("Four long titles and one offline-only channel ready in the synthetic UI database.");
} finally { await pool.end(); }
