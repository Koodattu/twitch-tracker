import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, expireMembershipWire, rollupExpiredMembership } from "@twitch-tracker/db";
import { readCommunityPresence } from "./community-presence.js";

const url = process.env.TEST_DATABASE_URL;
if (url != null && !new URL(url).pathname.includes("test")) throw new Error("A dedicated test database is required");
const database = url == null ? null : createDb(url);

describe.skipIf(database == null)("Daily membership retention", () => {
  if (database == null) return;
  const { db, pool } = database;
  beforeEach(async () => {
    await pool.query("truncate twitch_users cascade");
    await pool.query(`insert into twitch_users(twitch_user_id,login) values ('channel','channel'),('person','person'),('bot','bot');
      insert into bot_accounts(id,twitch_user_id,login) values ('00000000-0000-0000-0000-000000000001','bot','bot');
      insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,ended_at,is_finnish_eligible)
        values ('stream','channel','2020-01-01 20:00Z','2020-01-02 04:00Z',true);`);
  });
  afterAll(async () => { await pool.end(); });
  const add = async (kind: string, at: string, capture: number | null = null, person: string | null = "person") => {
    await pool.query(`select insert_captured_membership_event('channel',$1,'person','stream',$2::chat_membership_event_type,
      $3::timestamptz,null,sha256(uuid_send(gen_random_uuid())),null,$4::int)`, [person, kind, at, capture]);
  };
  const capture = async (start = "2020-01-01 22:30Z", end = "2020-01-02 03:00Z") => {
    const r = await pool.query(`insert into membership_capture_windows(context_id,bot_account_id,connection_id,started_at,last_seen_at,ended_at)
      values(get_membership_context('channel','stream'),'00000000-0000-0000-0000-000000000001',gen_random_uuid(),$1,$2,$2) returning id`, [start,end]);
    return r.rows[0].id as number;
  };
  const totals = async () => (await pool.query(`select sum(join_count+part_count)::int as appearances,
    sum(matched_milliseconds)::float8 as matched,sum(estimated_milliseconds)::float8 as estimated,
    sum(unmatched_join_count)::int as unmatched_joins,sum(unmatched_part_count)::int as unmatched_parts,
    sum(repeated_join_count)::int as repeated_joins,sum(repeated_part_count)::int as repeated_parts from membership_daily_summaries`)).rows[0];

  it("splits matched time at UTC midnight, preserves all appearances, and is retry-safe", async () => {
    const c = await capture();
    await add("join","2020-01-01 23:00Z",c);
    await add("part","2020-01-02 01:00Z",c);
    expect(await rollupExpiredMembership(db)).toMatchObject({ contexts: 1, events: 2, summaries: 2 });
    expect(await totals()).toMatchObject({ appearances: 2, matched: 7_200_000, estimated: 0 });
    const days = (await pool.query("select matched_milliseconds::int as ms from membership_daily_summaries order by day")).rows;
    expect(days).toEqual([{ ms: 3_600_000 }, { ms: 3_600_000 }]);
    expect(await rollupExpiredMembership(db)).toMatchObject({ events: 0, contexts: 0 });
    expect((await pool.query("select count(*)::int n from membership_events")).rows[0].n).toBe(0);
  });

  it("estimates missing boundaries inside coverage and counts repeated signals without overlapping time", async () => {
    const c = await capture();
    await add("part","2020-01-01 23:00Z",c);
    await add("part","2020-01-01 23:30Z",c);
    await add("join","2020-01-02 00:00Z",c);
    await add("join","2020-01-02 01:00Z",c);
    await add("part","2020-01-02 02:00Z",c);
    await add("join","2020-01-02 02:30Z",c);
    await rollupExpiredMembership(db);
    expect(await totals()).toMatchObject({ appearances: 6, matched: 3_600_000, estimated: 7_200_000,
      unmatched_joins: 2, unmatched_parts: 2, repeated_joins: 1, repeated_parts: 1 });
  });

  it("labels legacy pairs and stream-end closure as estimates", async () => {
    await add("join","2020-01-01 23:00Z");
    await add("part","2020-01-02 01:00Z");
    await add("join","2020-01-02 03:00Z");
    await rollupExpiredMembership(db);
    expect(await totals()).toMatchObject({ appearances: 3, matched: 0, estimated: 10_800_000 });
  });

  it("unions overlapping bot coverage and never bridges a disconnected interval", async () => {
    const a = await capture("2020-01-01 22:00Z","2020-01-01 23:00Z");
    const b = await capture("2020-01-02 01:00Z","2020-01-02 03:00Z");
    const c = await capture("2020-01-02 01:30Z","2020-01-02 03:00Z");
    await add("join","2020-01-01 22:00Z",a);
    await add("join","2020-01-02 01:00Z",b);
    await add("part","2020-01-02 02:00Z",b);
    await add("join","2020-01-02 01:30Z",c);
    await add("part","2020-01-02 02:30Z",c);
    await rollupExpiredMembership(db);
    expect(await totals()).toMatchObject({ appearances: 5, matched: 5_400_000, estimated: 3_600_000 });
  });

  it("retains recent events and open streams, and refuses an unsafe cutoff", async () => {
    await add("join",new Date().toISOString());
    expect(await rollupExpiredMembership(db)).toMatchObject({ contexts: 0 });
    await expect(pool.query("select rollup_expired_membership(now())")).rejects.toThrow("Seven complete days");
    await pool.query("update stream_sessions set ended_at=null");
    await pool.query("update membership_rollup_queue set last_event_at='2020-01-02'");
    expect(await rollupExpiredMembership(db)).toMatchObject({ contexts: 0 });
  });

  it("uses stream end for a missing PART while the bot remains connected", async () => {
    const c = await capture("2020-01-01 22:00Z","2020-01-01 23:00Z");
    await pool.query("update membership_capture_windows set ended_at=null where id=$1",[c]);
    await add("join","2020-01-01 23:00Z",c);
    await rollupExpiredMembership(db);
    expect(await totals()).toMatchObject({appearances:1,matched:0,estimated:18_000_000});
  });

  it("carries uninterrupted room coverage across a stream boundary for a missing JOIN", async () => {
    const query = `select record_membership_capture('00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002','channel',$1,$2) as id`;
    await pool.query(query,[null,"2020-01-01 19:00Z"]);
    const c = (await pool.query(query,["stream","2020-01-01 23:00Z"])).rows[0].id;
    await add("part","2020-01-01 23:00Z",c);
    await rollupExpiredMembership(db);
    expect(await totals()).toMatchObject({appearances:1,matched:0,estimated:10_800_000});
  });

  it("expires offline history even when the same channel has fresh offline events", async () => {
    await pool.query(`insert into chat_membership_events(broadcaster_user_id,chatter_user_id,chatter_login,event_type,received_at)
      values('channel','person','person','join','2020-01-01'),('channel','person','person','part',now());`);
    expect(await rollupExpiredMembership(db)).toMatchObject({contexts:1,events:1});
    expect(await totals()).toMatchObject({appearances:1,matched:0,estimated:0});
    expect((await pool.query("select count(*)::int n from membership_events")).rows[0].n).toBe(1);
  });

  it("opens a new coverage window when the same socket rejoins a room", async () => {
    const query = `select record_membership_capture('00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000002','channel','stream',$1) as id`;
    const first = (await pool.query(query,["2020-01-01 22:00Z"])).rows[0].id;
    expect((await pool.query(query,["2020-01-01 22:01Z"])).rows[0].id).toBe(first);
    await pool.query("update membership_capture_windows set ended_at='2020-01-01 23:00Z' where id=$1",[first]);
    const next = (await pool.query(query,["2020-01-02 01:00Z"])).rows[0].id;
    expect(next).not.toBe(first);
  });

  it("counts late evidence without adding time overlapping finalized history", async () => {
    await add("join","2020-01-01 23:00Z");
    await add("part","2020-01-02 01:00Z");
    await rollupExpiredMembership(db);
    await add("join","2020-01-02 00:00Z");
    await add("part","2020-01-02 02:00Z");
    await rollupExpiredMembership(db);
    expect(await totals()).toMatchObject({appearances:4,estimated:7_200_000});
  });

  it("reuses an empty connection-local workspace across committed batches", async () => {
    await add("join","2020-01-01 23:00Z");
    const client = await pool.connect();
    try {
      await client.query("select rollup_expired_membership()");
      const first = (await client.query("select 'pg_temp.membership_rollup_input'::regclass::oid as id")).rows[0].id;
      await add("part","2020-01-02 01:00Z");
      await client.query("select rollup_expired_membership()");
      expect((await client.query("select 'pg_temp.membership_rollup_input'::regclass::oid as id")).rows[0].id).toBe(first);
      expect((await client.query("select count(*)::int n from membership_rollup_input")).rows[0].n).toBe(0);
    } finally { client.release(); }
    expect(await totals()).toMatchObject({appearances:2});
  });

  it("batches contexts without merging the same person's time across channels", async () => {
    await add("join","2020-01-01 23:00Z");
    await pool.query(`insert into twitch_users(twitch_user_id,login) values('other','other');
      insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,ended_at,is_finnish_eligible)
        values('other-stream','other','2020-01-01 20:00Z','2020-01-02 04:00Z',true);
      select insert_membership_event('other','person','person','other-stream','join','2020-01-01 23:00Z',null,sha256(uuid_send(gen_random_uuid())),null);`);
    expect(await rollupExpiredMembership(db)).toMatchObject({contexts:2,events:2});
    expect(await totals()).toMatchObject({appearances:2,matched:0,estimated:36_000_000});
  });

  it("expires only unreferenced old JOIN/PART wire copies and clears just their archived slots", async () => {
    const raw = (await pool.query(`insert into raw_irc_records(raw_line,parsed_command,received_at) values
      (':person JOIN #channel','!JOIN','2020-01-01 21:00Z'),
      (':person PART #channel','!PART','2020-01-01 22:00Z'),
      (':person PRIVMSG #channel :keep this message','','2020-01-01 23:00Z'),
      (':person JOIN #channel','!JOIN','2020-01-02 00:00Z'),
      (':person JOIN #channel','!JOIN',now()) returning id`)).rows;
    await pool.query(`select insert_membership_event('channel','person','person','stream','join','2020-01-02 00:00Z',null,sha256(uuid_send(gen_random_uuid())),$1)`,[raw[3].id]);
    await pool.query("insert into membership_raw_evidence values($1,'person','person')",[raw[0].id]);
    await pool.query("select compact_raw_irc_batch('2020-01-03',256)");
    const client = await pool.connect();
    try {
      await client.query("begin");
      expect((await client.query("select expire_membership_wire_batch('2020-01-03',5000) n")).rows[0].n).toBe(2);
      await client.query("rollback");
    } finally { client.release(); }
    expect((await pool.query("select count(*)::int n from raw_irc_records")).rows[0].n).toBe(5);
    expect(await expireMembershipWire(db)).toBe(2);
    expect((await pool.query("select count(*)::int n from raw_irc_records")).rows[0].n).toBe(3);
    expect((await pool.query("select count(*)::int n from membership_raw_evidence")).rows[0].n).toBe(0);
    expect((await pool.query("select read_raw_irc_line(raw_line,payload_block_id,payload_position) line from raw_irc_records where id=$1",[raw[2].id])).rows[0].line).toBe(':person PRIVMSG #channel :keep this message');
    expect((await pool.query("select count(*)::int n from raw_irc_payload_blocks b cross join lateral unnest(b.lines) line where b.id=(select payload_block_id from raw_irc_records where id=$1) and line is null",[raw[2].id])).rows[0].n).toBe(2);
    await expect(pool.query("select expire_membership_wire_batch(now(),5000)")).rejects.toThrow("Seven complete days");
  });

  it("rolls back totals and deletion together and preserves legacy privacy links", async () => {
    const raw = (await pool.query("insert into raw_irc_records(raw_line,received_at) values(':person JOIN #channel','2020-01-01 23:00Z') returning id")).rows[0].id;
    await pool.query(`select insert_membership_event('channel','person','person','stream','join','2020-01-01 23:00Z',null,sha256(uuid_send(gen_random_uuid())),$1)`,[raw]);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select rollup_expired_membership()");
      await client.query("rollback");
    } finally { client.release(); }
    expect((await pool.query("select count(*)::int n from membership_events")).rows[0].n).toBe(1);
    expect((await pool.query("select count(*)::int n from membership_daily_summaries")).rows[0].n).toBe(0);
    await rollupExpiredMembership(db);
    expect((await pool.query("select raw_irc_message_id,chatter_user_id from membership_raw_evidence")).rows).toEqual([{raw_irc_message_id:raw,chatter_user_id:"person"}]);
  });

  it("preserves community membership and coverage across compaction, including unresolved identities", async () => {
    await add("join","2020-01-01 20:30Z");
    await add("part","2020-01-02 03:00Z");
    await add("part","2020-01-02 03:30Z",null,null);
    const claim = { windowStart:new Date("2020-01-01"),windowEnd:new Date("2020-01-03") } as Parameters<typeof readCommunityPresence>[1];
    const before = await readCommunityPresence(db,claim);
    expect(before.members).toHaveLength(1);
    await rollupExpiredMembership(db);
    expect(await readCommunityPresence(db,claim)).toEqual(before);
  });
});
