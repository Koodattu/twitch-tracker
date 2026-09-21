import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./index.js";

const url = process.env.TEST_DATABASE_URL;
if (url != null && !new URL(url).pathname.toLowerCase().includes("test")) throw new Error("TEST_DATABASE_URL must name a dedicated test database.");
const database = url == null ? null : createDb(url);

describe.skipIf(database == null)("Normalized membership storage", () => {
  if (database == null) return;
  const { pool } = database;
  beforeEach(async () => {
    await pool.query("truncate table twitch_users cascade");
    await pool.query("insert into twitch_users(twitch_user_id) values ('channel'),('person')");
  });
  afterAll(async () => { await pool.end(); });
  const collision = () => Buffer.concat([Buffer.alloc(8), randomBytes(24)]);
  const insert = (digest: Buffer) => pool.query("select id from insert_membership_event('channel','person','person',null,'join',now(),now(),$1)", [digest]);

  it("distinguishes concurrent 64-bit collisions using the full digest and handles deleted slots", async () => {
    const digests = Array.from({ length: 8 }, collision);
    const results = await Promise.all(digests.map(insert));
    expect(results.every((r) => r.rows.length === 1)).toBe(true);
    expect((await pool.query("select count(distinct digest_slot)::int as slots,count(distinct digest_bucket)::int as buckets from membership_events")).rows[0]).toEqual({ slots: 8, buckets: 1 });
    for (const digest of digests) expect((await insert(digest)).rows).toHaveLength(0);
    await pool.query("delete from chat_membership_events where id=$1", [results[0]!.rows[0].id]);
    expect((await insert(digests[1]!)).rows).toHaveLength(0);
    expect((await insert(digests[0]!)).rows).toHaveLength(1);
    expect((await pool.query("select count(*)::int as n from membership_events")).rows[0].n).toBe(8);
  });

  it("rejects a duplicate full digest during updates without changing either event", async () => {
    const first = collision(), second = collision();
    const a = (await insert(first)).rows[0], b = (await insert(second)).rows[0];
    await expect(pool.query("update chat_membership_events set dedupe_key_storage=$1 where id=$2", [first,b.id])).rejects.toThrow("chat_membership_events_dedupe_key_idx");
    expect((await pool.query("select dedupe_key_storage from chat_membership_events where id=$1", [b.id])).rows[0].dedupe_key_storage).toEqual(second);
    expect(a.id).not.toBe(b.id);
  });

  it("requests a transaction retry when a collision is invisible to a repeatable-read snapshot", async () => {
    await pool.query("select get_membership_context('channel',null),get_membership_identity('person','person',now(),false)");
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read");
      await client.query("select count(*) from membership_events");
      await insert(collision());
      await expect(client.query("select * from insert_membership_event('channel','person','person',null,'join',now(),now(),$1)", [collision()])).rejects.toMatchObject({ code: "40001" });
    } finally { await client.query("rollback"); client.release(); }
  });

  it("closes a pending identity cohort without rewriting its events and never reuses a closed cohort", async () => {
    await pool.query(`insert into chat_membership_events(broadcaster_user_id,chatter_login,event_type,received_at)
      values ('channel','lurker','join','2026-09-21 10:01:00+00'),('channel','lurker','part','2026-09-21 10:02:00+00')`);
    const before = (await pool.query("select id,ctid::text,identity_id from membership_events order by id")).rows;
    expect(new Set(before.map((r) => r.identity_id)).size).toBe(1);
    expect((await pool.query("select resolve_membership_identity('lurker','person','2026-09-21 00:00:00+00','2026-09-21 11:00:00+00','2026-09-21 11:00:00.123456+00','2026-09-21 11:00:00.654321+00') as n")).rows[0].n).toBe(2);
    expect((await pool.query("select id,ctid::text,identity_id from membership_events order by id")).rows).toEqual(before);
    const logical = (await pool.query("select chatter_user_id,identity_checked_at::text,updated_at::text from chat_membership_events")).rows;
    expect(logical.every((r) => r.chatter_user_id === "person" && r.identity_checked_at.includes(".123456") && r.updated_at.includes(".654321"))).toBe(true);
    await pool.query("insert into chat_membership_events(broadcaster_user_id,chatter_login,event_type,received_at) values ('channel','lurker','join','2026-09-21 10:03:00+00')");
    expect((await pool.query("select count(*)::int as n from chat_membership_events where chatter_user_id is null and identity_checked_at is null")).rows[0].n).toBe(1);
  });

  it("splits a cohort at the resolution window and preserves excluded observations", async () => {
    await pool.query(`insert into chat_membership_events(broadcaster_user_id,chatter_login,event_type,received_at)
      values ('channel','lurker','join','2026-09-21 10:01:00+00'),('channel','lurker','part','2026-09-21 10:45:00+00')`);
    expect((await pool.query("select resolve_membership_identity('lurker','person','2026-09-21 10:30:00+00','2026-09-21 11:00:00+00',now(),now()) as n")).rows[0].n).toBe(1);
    expect((await pool.query("select chatter_user_id,identity_checked_at from chat_membership_events where received_at='2026-09-21 10:01:00+00'")).rows[0]).toEqual({ chatter_user_id: null, identity_checked_at: null });
  });

  it("does not resolve an event committed into a cohort after the resolver's observation cutoff", async () => {
    const inserted = await pool.query("insert into chat_membership_events(broadcaster_user_id,chatter_login,event_type,received_at) values ('channel','lurker','join','2026-09-21 10:01:00+00') returning id");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("insert into chat_membership_events(broadcaster_user_id,chatter_login,event_type,received_at) values ('channel','lurker','part','2026-09-21 10:03:00+00')");
      const resolving = pool.query("select resolve_membership_identity('lurker','person','2026-09-21 10:00:00+00','2026-09-21 10:02:00+00',now(),now()) as n");
      await client.query("commit");
      expect((await resolving).rows[0].n).toBe(1);
      expect((await pool.query("select chatter_user_id from chat_membership_events where id=$1", [inserted.rows[0].id])).rows[0].chatter_user_id).toBe("person");
      expect((await pool.query("select chatter_user_id from chat_membership_events where received_at='2026-09-21 10:03:00+00'")).rows[0].chatter_user_id).toBeNull();
    } finally { await client.query("rollback"); client.release(); }
  });

  it("removes unreferenced identity metadata on subject redaction while preserving deduplication", async () => {
    const digest = collision();
    await insert(digest);
    await pool.query("update chat_membership_events set chatter_user_id=null,chatter_login=null,updated_at=now(); select prune_membership_subject('person','person')");
    expect((await pool.query("select count(*)::int as n from membership_event_identities where chatter_user_id='person' or chatter_login='person'")).rows[0].n).toBe(0);
    expect((await pool.query("select dedupe_key_storage from chat_membership_events")).rows[0].dedupe_key_storage).toEqual(digest);
  });

  it("generates UUIDv7 event IDs while preserving explicitly supplied legacy IDs", async () => {
    const rows = (await pool.query("select membership_event_uuid()::text as id from generate_series(1,1000)")).rows;
    expect(new Set(rows.map((r) => r.id)).size).toBe(1000);
    expect(rows.every((r) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.id))).toBe(true);
    const millis = Number.parseInt(rows[0].id.replaceAll("-", "").slice(0,12),16);
    expect(Math.abs(Date.now()-millis)).toBeLessThan(10000);
    const legacy = "11111111-1111-4111-8111-111111111111";
    expect((await pool.query("insert into chat_membership_events(id,broadcaster_user_id,event_type) values ($1,'channel','join') returning id", [legacy])).rows[0].id).toBe(legacy);
  });
});
