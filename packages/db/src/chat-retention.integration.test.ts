import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./index.js";
import { expireChatWire } from "./chat-retention.js";

const url = process.env.TEST_DATABASE_URL;
if (url != null && !new URL(url).pathname.includes("test")) throw new Error("A dedicated test database is required");
const database = url == null ? null : createDb(url);

describe.skipIf(database == null)("Thirty-day raw chat retention", () => {
  if (database == null) return;
  const { db, pool } = database;
  beforeEach(async () => {
    await pool.query("truncate twitch_users, raw_irc_records, raw_irc_payload_blocks cascade");
    await pool.query("insert into twitch_users(twitch_user_id,login) values ('channel','channel'),('person','person')");
  });
  afterAll(async () => { await pool.end(); });
  const raw = async (line = "@id=message :person PRIVMSG #channel :Hello", at = "2020-01-01Z", command = "") =>
    (await pool.query(`insert into raw_irc_records(raw_line,received_at,parsed_command,processing_status)
      values($1,$2,$3,'processed') returning id`, [line,at,command])).rows[0].id as string;
  const message = async (id: string, wire: string, at = "2020-01-01Z", source: string | null = null) => {
    await pool.query(`insert into chat_messages(twitch_message_id,broadcaster_user_id,chatter_user_id,chatter_login,
      raw_text,received_at,raw_irc_message_id,shared_chat_source_channel_id)
      values(encode_chat_message_id($1),encode_external_key('channel'),encode_external_key('person'),'person',
      'Hello',$3,$2,encode_external_key($4))`, [id,wire,at,source]);
  };
  const facts = async () => (await pool.query(`select to_jsonb(m)-'raw_irc_message_id'-'unrelayed_source' as facts
    from chat_messages m order by twitch_message_id`)).rows;

  it("preserves all structured facts and classifications while clearing only eligible mixed-block slots", async () => {
    const ordinary = await raw(); await message("ordinary",ordinary);
    const relay = await raw("@source-room-id=other :person PRIVMSG #channel :Hello"); await message("relay",relay,"2020-01-01Z","other");
    const unknown = await raw(":person PRIVMSG #channel :Hello"); await message("unknown",unknown);
    const notice = await raw(":server NOTICE #channel :keep", "2020-01-01Z", "!NOTICE");
    const before = await facts();
    await pool.query("select compact_raw_irc_batch(now(),256)");
    expect(await expireChatWire(db)).toBe(3);
    expect(await facts()).toEqual(before);
    expect((await pool.query(`select decode_chat_message_id(twitch_message_id) as id,unrelayed_source as ordinary,raw_irc_message_id as wire
      from chat_messages order by id`)).rows).toEqual([
      { id:"ordinary",ordinary:true,wire:null }, { id:"relay",ordinary:false,wire:null }, { id:"unknown",ordinary:false,wire:null }
    ]);
    expect((await pool.query("select read_raw_irc_line(raw_line,payload_block_id,payload_position) as line from raw_irc_records where id=$1",[notice])).rows[0].line).toBe(":server NOTICE #channel :keep");
    expect((await pool.query("select count(*)::int n from raw_irc_payload_blocks b cross join lateral unnest(b.lines) line where line is null")).rows[0].n).toBe(3);
    expect(await expireChatWire(db)).toBe(0);
  });

  it("keeps the exact thirty-day boundary and rejects unsafe cutoffs or batch limits", async () => {
    const cutoff = (await pool.query("select date_trunc('day',now(),'UTC')-interval '30 days' as cutoff")).rows[0].cutoff as Date;
    const wire = await raw(undefined,cutoff.toISOString()); await message("boundary",wire,cutoff.toISOString());
    const oldAt = new Date(cutoff.getTime()-1).toISOString();
    const old = await raw(undefined,oldAt); await message("old",old,oldAt);
    expect(await expireChatWire(db)).toBe(1);
    expect((await pool.query("select id from raw_irc_records")).rows).toEqual([{id:wire}]);
    await expect(pool.query("select expire_chat_wire_batch(now(),1)")).rejects.toThrow("Thirty complete days");
    await expect(pool.query("select expire_chat_wire_batch(null,1)")).rejects.toThrow("Thirty complete days");
    await expect(pool.query("select expire_chat_wire_batch('2020-02-01',5001)")).rejects.toThrow("batch size");
  });

  it("retains unnormalized, failed, incomplete, recent-linked and other-event evidence", async () => {
    await raw();
    const failed = await raw(); await message("failed",failed);
    await pool.query("update raw_irc_records set processing_status='failed' where id=$1",[failed]);
    const incomplete = await raw(); await message("incomplete",incomplete);
    await pool.query("update chat_messages set raw_text=null where raw_irc_message_id=$1",[incomplete]);
    const recent = await raw(); await message("recent",recent,new Date().toISOString());
    const room = await raw(); await message("room",room);
    await pool.query("insert into chat_room_state_events(state_type,raw_irc_message_id) values('ROOMSTATE',$1)",[room]);
    const event = await raw(); await message("event",event);
    await pool.query("insert into channel_events(event_type,occurred_at,source,raw_irc_message_id) values('notice',now(),'irc',$1)",[event]);
    const member = await raw(); await message("member",member);
    await pool.query(`select insert_membership_event('channel','person','person',null,'join','2020-01-01',null,
      sha256(uuid_send(gen_random_uuid())),$1::uuid)`,[member]);
    expect(await expireChatWire(db)).toBe(0);
    expect((await pool.query("select count(*)::int n from raw_irc_records")).rows[0].n).toBe(7);
  });

  it("rolls back detachment, classification and payload deletion together and handles multiple message references", async () => {
    const wire = await raw(); await message("first",wire); await message("second",wire);
    const client = await pool.connect();
    try {
      await client.query("begin");
      expect((await client.query("select expire_chat_wire_batch('2020-02-01',1) as count")).rows[0].count).toBe(1);
      await client.query("rollback");
    } finally { client.release(); }
    expect((await pool.query("select count(*)::int n from chat_messages where raw_irc_message_id=$1 and unrelayed_source is null",[wire])).rows[0].n).toBe(2);
    expect(await expireChatWire(db)).toBe(1);
    expect((await pool.query("select count(*)::int n from chat_messages where raw_irc_message_id is null and unrelayed_source")).rows[0].n).toBe(2);
  });
});
