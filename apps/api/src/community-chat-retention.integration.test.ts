import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, expireChatWire } from "@twitch-tracker/db";
import { getCommunityChatterActivity } from "./community-chatter.js";

const url = process.env.TEST_DATABASE_URL;
if (url != null && !new URL(url).pathname.includes("test")) throw new Error("A dedicated test database is required");
const database = url == null ? null : createDb(url);
describe.skipIf(database == null)("Private community activity after chat wire expiry", () => {
  if (database == null) return;
  const { db, pool } = database;
  beforeEach(async () => {
    await pool.query("truncate community_map_state,community_map_snapshots,twitch_users,raw_irc_records,raw_irc_payload_blocks cascade");
    await pool.query(`insert into twitch_users(twitch_user_id,login) values ('channel','channel'),('person','person');
      insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,ended_at,is_finnish_eligible)
        values('stream','channel','2020-01-01','2020-01-02',true);
      insert into community_map_snapshots(id,recipe,window_start,window_end,privacy_version,graph)
        values('00000000-0000-0000-0000-000000000035','test','2020-01-01','2020-03-01',0,'{"nodes":[{"id":"channel"}],"edges":[]}');
      insert into community_map_state(id,snapshot_id) values('current','00000000-0000-0000-0000-000000000035');`);
  });
  afterAll(async () => { await pool.end(); });
  it("preserves private lookup counts, dates and channel eligibility", async () => {
    for (let i=0;i<3;i++) {
      const raw = (await pool.query(`insert into raw_irc_records(raw_line,parsed_command,processing_status,received_at)
        values('@id=message :person PRIVMSG #channel :Hello','','processed','2020-01-01') returning id`)).rows[0].id;
      await pool.query(`insert into chat_messages(twitch_message_id,broadcaster_user_id,twitch_stream_id,chatter_user_id,raw_text,received_at,raw_irc_message_id)
        values(encode_chat_message_id($1),encode_external_key('channel'),encode_external_key('stream'),encode_external_key('person'),'Hello','2020-01-01',$2)`,[String(i),raw]);
    }
    const before = await getCommunityChatterActivity(db,"person");
    expect(before.channels).toHaveLength(1);
    expect(before.channels[0]).toMatchObject({ channelId:"channel",messages:3,messageDays:1 });
    expect(await expireChatWire(db)).toBe(3);
    expect(await getCommunityChatterActivity(db,"person")).toEqual(before);
  });
});
