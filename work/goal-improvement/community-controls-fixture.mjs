// Deterministic synthetic map and admin account in the dedicated disposable UI database only.
import { createRequire } from "node:module";
import { fixtureUrl } from "./fixture.mjs";
import { encryptSecret, hashSessionToken } from "../../packages/config/dist/index.js";
const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { Pool } = require("pg");
if (new URL(fixtureUrl).hostname !== "127.0.0.1" || !fixtureUrl.endsWith("/twitch_tracker_goal_ui_test")) throw new Error("Use the dedicated UI test database.");
const pool = new Pool({ connectionString: fixtureUrl });
try {
  await pool.query("truncate twitch_users, community_map_state, community_map_snapshots cascade");
  const nodes = [], edges = [], users = [];
  const centers = [[260, 300], [780, 380], [490, 820]];
  const names = ["Aurora", "Sisu", "Kettu"];
  const groups = ["block-builders", "competitive-evening", "creative-chat"];
  for (let group = 0; group < 3; group++) {
    for (let i = 0; i < 24; i++) {
      const angle = i * 2.39996, radius = i === 0 ? 0 : 30 + Math.sqrt(i) * 32;
      const id = `qa-${group}-${i}`;
      nodes.push({ id, chatters: 40 + i * 7, participants: 60 + i * 7, community: groups[group],
        x: centers[group][0] + Math.cos(angle) * radius, y: centers[group][1] + Math.sin(angle) * radius,
        ...(group === 2 ? {} : { category: { id: `game-${group === 0 ? 0 : i % 3}`, name: group === 0 ? "Minecraft" : ["Counter-Strike", "Just Chatting", "Art"][i % 3], share: i % 7 === 0 ? 0.4 : 0.9 } }) });
      users.push([id, `${names[group].toLowerCase()}${i}`, `${names[group]}${String(i).padStart(2, "0")}`]);
    }
    const pairs = new Set();
    for (let i = 0; i < 24; i++) for (const j of [0, (i + 1) % 24, (i + 2) % 24]) {
      const a = Math.min(i, j), b = Math.max(i, j), key = `${a}-${b}`;
      if (a === b || pairs.has(key)) continue;
      pairs.add(key);
      edges.push({ source: `qa-${group}-${a}`, target: `qa-${group}-${b}`, shared: 8 + b, score: (30 - b) / 80 });
    }
  }
  for (let i = 0; i < 24; i++) {
    const id = `sparse-${i}`, isolated = i >= 18;
    nodes.push({ id, chatters: 10, participants: 12, community: isolated ? null : groups[i % 3],
      x: isolated ? 1180 : 470 + (i % 6) * 18, y: isolated ? 220 + (i - 18) * 90 : 500 + Math.floor(i / 6) * 20 });
    users.push([id, `quietchannel${i}`, `QuietChannel${i}`]);
    if (!isolated) edges.push({ source: id, target: `qa-${i % 3}-0`, shared: 5, score: 0.2 });
  }
  for (const user of [...users, ["qa-admin", "mapadmin", "MapAdmin"], ["qa-chatter", "testichat", "TestiChat"], ["qa-empty", "quietviewer", "QuietViewer"]]) {
    await pool.query("insert into twitch_users(twitch_user_id,login,display_name) values($1,$2,$3)", user);
  }
  const end = new Date(), start = new Date(end.getTime() - 30 * 86400_000), day = new Date(start.getTime() + 86400_000);
  for (const id of ["qa-0-0", "qa-1-3", "sparse-2"]) {
    await pool.query("insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,ended_at,is_finnish_eligible) values($1,$2,$3,$4,true)", [`stream-${id}`, id, start, end]);
    if (id === "qa-1-3") {
      for (let i = 0; i < 3; i++) await pool.query("insert into chat_membership_events(broadcaster_user_id,twitch_stream_id,chatter_user_id,event_type,received_at) values($1,$2,'qa-chatter','join',$3)", [id, `stream-${id}`, new Date(day.getTime() + i * 86400_000)]);
    } else for (let i = 0; i < 6; i++) await pool.query("insert into chat_messages(twitch_message_id,broadcaster_user_id,twitch_stream_id,chatter_user_id,shared_chat_source_channel_id,received_at,raw_text) values(encode_chat_message_id($1),$2,$3,'qa-chatter',$2,$4,'Synthetic QA')", [`map-${id}-${i}`, id, `stream-${id}`, day]);
  }
  const coverage = { firstObservedAt: day.toISOString(), lastObservedAt: end.toISOString(), messages: 45000, missingSession: 0, unknownSource: 0, relayedMessages: 0, qualifyingMemberships: 18000,
    presence: { events: 10000, unresolvedEvents: 0, recoveredEvents: 0, observedChannels: 90, snapshotChannels: 24, qualifyingMemberships: 8000, presenceOnlyMemberships: 4000 } };
  const snapshot = await pool.query("insert into community_map_snapshots(recipe,window_start,window_end,privacy_version,graph,coverage) values('synthetic-community-controls',$1,$2,0,$3,$4) returning id", [start, end, { nodes, edges }, coverage]);
  await pool.query("insert into community_map_state(id,status,snapshot_id) values('current','ready',$1)", [snapshot.rows[0].id]);
  const secret = "synthetic-local-goal-test-session-secret-only";
  const user = await pool.query("insert into app_users(twitch_user_id,is_admin) values('qa-admin',true) returning id");
  await pool.query("insert into sessions(session_id_hash,app_user_id,expires_at) values($1,$2,now()+interval '3 hours')", [hashSessionToken("synthetic-community-admin", secret), user.rows[0].id]);
  await pool.query("insert into oauth_accounts(app_user_id,provider,provider_user_id,encrypted_access_token,last_validated_at,expires_at) values($1,'twitch','qa-admin',$2,now(),now()+interval '3 hours')", [user.rows[0].id, encryptSecret("synthetic-not-a-twitch-token", secret)]);
  console.log(JSON.stringify({ channels: nodes.length, edges: edges.length, sparse: 18, isolated: 6, chatter: "testichat", highlighted: ["qa-0-0", "qa-1-3", "sparse-2"] }));
} finally { await pool.end(); }
