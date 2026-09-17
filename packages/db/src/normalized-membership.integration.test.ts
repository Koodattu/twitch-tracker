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

  it("round trips nullable, historical and non-default metadata with microsecond precision", async () => {
    const bot = (await pool.query("insert into bot_accounts(login,twitch_user_id) values ('fixture','person') returning id")).rows[0];
    const connection = (await pool.query("insert into irc_connections(bot_account_id) values ($1) returning id", [bot.id])).rows[0];
    const raw = (await pool.query("insert into raw_irc_messages(raw_line) values ('synthetic') returning id")).rows[0];
    for (const [eventAt, checkedAt] of [[null, null], ["2026-09-17 10:00:00.123456+00", "2026-09-17 10:00:00.123456+00"], ["1969-12-31 23:59:59.999999+00", "2026-09-17 11:00:00.000001+00"]]) {
      const inserted = (await pool.query(`with inserted as (
        insert into chat_membership_events(broadcaster_user_id,chatter_user_id,chatter_login,event_type,event_at,received_at,
          identity_checked_at,created_at,updated_at,source,confidence,raw_irc_message_id,irc_connection_id)
        values ('channel','person','ä:😀','part',$1,'2026-09-17 10:00:00.123456+00',$2,
          '2026-09-17 09:00:00.000001+00','2026-09-17 12:00:00.000002+00','!historical',42,$3,$4) returning *
      ) select to_jsonb(inserted) as record from inserted`, [eventAt, checkedAt, raw.id, connection.id])).rows[0].record;
      const selected = (await pool.query("select to_jsonb(m) as record from chat_membership_events m where id=$1", [inserted.id])).rows[0].record;
      expect(selected).toEqual(inserted);
      expect(selected.confidence).toBe(42);
      expect(selected.source).toBe("!historical");
      expect(selected.raw_irc_message_id).toBe(raw.id);
    }
  });

  it("shares dictionaries while preserving unresolved identities and distinct logins", async () => {
    for (const [person, login] of [[null, "person"], ["person", "person"], ["person", "old-name"], [null, null], [null, ""]]) {
      await pool.query("insert into chat_membership_events(broadcaster_user_id,chatter_user_id,chatter_login,event_type) values ('channel',$1,$2,'join'),('channel',$1,$2,'part')", [person, login]);
    }
    expect((await pool.query("select count(*)::int as n from membership_event_contexts")).rows[0].n).toBe(1);
    expect((await pool.query("select count(*)::int as n from membership_event_identities")).rows[0].n).toBe(5);
    expect((await pool.query("select count(*)::int as n from chat_membership_events")).rows[0].n).toBe(10);
    await expect(pool.query("update membership_event_identities set chatter_login='changed'")).rejects.toThrow("immutable");
    await expect(pool.query("delete from membership_event_contexts")).rejects.toThrow("foreign key");
  });

  it("suppresses concurrent duplicates while retaining ordinary insert errors", async () => {
    const calls = await Promise.all(Array.from({ length: 8 }, () => pool.query("select id from insert_membership_event('channel','person','person',null,'join','2026-09-17 10:00:00.123456+00',null)")));
    expect(calls.reduce((sum, result) => sum + result.rows.length, 0)).toBe(1);
    await expect(pool.query("insert into chat_membership_events(broadcaster_user_id,chatter_login,event_type,event_at,dedupe_key_storage) values ('channel','person','join','2026-09-17 10:00:00.999999+00',decode('','hex'))")).rejects.toThrow("chat_membership_events_dedupe_key_idx");
    await expect(pool.query("select * from insert_membership_event('missing',null,'person',null,'join',now(),null)")).rejects.toThrow("foreign key");
    expect((await pool.query("select count(*)::int as n from membership_event_contexts")).rows[0].n).toBe(1);
  });

  it("preserves exact metadata updates and supports deletion and rollback", async () => {
    const inserted = (await pool.query("insert into chat_membership_events(broadcaster_user_id,event_type) values ('channel','join') returning id")).rows[0];
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("update chat_membership_events set chatter_user_id='person',chatter_login='person',event_type='part',event_at='2026-09-17 10:00:00.123456+00',identity_checked_at=received_at,source='!manual',confidence=99 where id=$1", [inserted.id]);
      const updated = (await client.query("select * from chat_membership_events where id=$1", [inserted.id])).rows[0];
      expect(updated).toMatchObject({ chatter_user_id: "person", chatter_login: "person", event_type: "part", source: "!manual", confidence: 99 });
      expect(updated.identity_checked_at).toEqual(updated.received_at);
      await client.query("delete from chat_membership_events where id=$1", [inserted.id]);
      expect((await client.query("select count(*)::int as n from membership_event_rows")).rows[0].n).toBe(0);
      await client.query("rollback");
    } finally { await client.query("rollback"); client.release(); }
    expect((await pool.query("select event_type from chat_membership_events where id=$1", [inserted.id])).rows[0].event_type).toBe("join");
  });
});
