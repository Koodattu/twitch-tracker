import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { chatMembershipEvents, createDb, membershipDedupeKeySql, rawIrcMessages } from "./index.js";
import { sql } from "drizzle-orm";

const url = process.env.TEST_DATABASE_URL;
if (url != null && !new URL(url).pathname.toLowerCase().includes("test")) throw new Error("TEST_DATABASE_URL must name a dedicated test database.");
const database = url == null ? null : createDb(url);

describe.skipIf(database == null)("Derived membership keys and shared IRC contexts", () => {
  if (database == null) return;
  const { db, pool } = database;
  beforeEach(async () => {
    await pool.query("truncate table twitch_users cascade");
    await pool.query("truncate table raw_irc_contexts cascade");
    await pool.query("insert into twitch_users(twitch_user_id) values ('channel'), ('person')");
  });
  afterAll(async () => { await pool.end(); });

  const key = (login: string | null, at: string, stream: string | null = null, kind = "join") => createHash("sha256")
    .update(["irc_membership", "channel", stream ?? "no-stream", kind, login ?? "unknown", new Date(Math.floor(new Date(at).getTime() / 1000) * 1000).toISOString()].join(":"))
    .digest();
  const logicalKey = "read_membership_key(broadcaster_user_id,twitch_stream_id,event_type,chatter_login,event_at,dedupe_key_storage)";

  it.each([
    ["ää😀:user", "2026-09-15T10:12:13.999Z"],
    ["", "2026-09-15T10:12:13.001Z"],
    [null, "1969-12-31T23:59:59.999Z"],
    ["unknown", "2000-02-29T00:00:00.000Z"]
  ])("reconstructs every digest bit for %s at %s independently of session timezone", async (login, at) => {
    const expected = key(login, at!);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local time zone 'Pacific/Chatham'");
      const inserted = (await client.query(`insert into chat_membership_events(broadcaster_user_id,event_type,chatter_login,event_at,dedupe_key_storage)
        values ('channel','join',$1,$2,$3) returning octet_length(dedupe_key_storage) as stored_bytes,${logicalKey} as logical_key`, [login, at, expected])).rows[0];
      expect(inserted.stored_bytes).toBe(0);
      expect(inserted.logical_key).toEqual(expected);
      await client.query("rollback");
    } finally { await client.query("rollback"); client.release(); }
  });

  it("keeps microsecond timestamps unchanged and preserves null and non-derived keys", async () => {
    const at = "2026-09-15 10:12:13.123456+00";
    const arbitrary = createHash("sha256").update("legacy or unusual source").digest();
    for (const digest of [null, arbitrary, key("person", at)]) {
      const row = (await pool.query(`insert into chat_membership_events(broadcaster_user_id,event_type,chatter_login,event_at,dedupe_key_storage)
        values ('channel','join','person',$1,$2) returning to_char(event_at at time zone 'UTC','SS.US') as precise,${logicalKey} as key`, [at, digest])).rows[0];
      expect(row.precise).toBe("13.123456");
      expect(row.key).toEqual(digest);
    }
    await expect(pool.query("insert into chat_membership_events(broadcaster_user_id,event_type,dedupe_key_storage) values ('channel','join',decode('','hex'))")).rejects.toThrow("membership_digest_length");
  });

  it("retains uniqueness and the worker's ON CONFLICT behavior across derived and stored digests", async () => {
    const at = new Date("2026-09-15T10:12:13.456Z");
    const expected = key("person", at.toISOString());
    const value = { broadcasterUserId: "channel", eventType: "join" as const, chatterLogin: "person", eventAt: at, dedupeKeyStorage: expected.toString("base64url") };
    await db.insert(chatMembershipEvents).values(value);
    expect(await db.insert(chatMembershipEvents).values({ ...value, dedupeKeyStorage: "" }).onConflictDoNothing().returning()).toEqual([]);
    expect(await db.insert(chatMembershipEvents).values(value).onConflictDoNothing().returning()).toEqual([]);
    expect(await db.insert(chatMembershipEvents).values({ ...value, chatterLogin: "different" }).onConflictDoNothing().returning()).toEqual([]);
    const selected = await db.select({ key: membershipDedupeKeySql }).from(chatMembershipEvents);
    expect(selected[0]!.key).toEqual(expected);
  });

  it("materializes the original digest on redaction or identity changes, including transaction rollback", async () => {
    const expected = key("person", "2026-09-15T10:12:13Z");
    await pool.query("insert into chat_membership_events(broadcaster_user_id,chatter_user_id,chatter_login,event_type,event_at,dedupe_key_storage) values ('channel','person','person','join','2026-09-15T10:12:13Z',$1)", [expected]);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("update chat_membership_events set chatter_user_id=null,chatter_login=null,updated_at=now()");
      const row = (await client.query(`select dedupe_key_storage,${logicalKey} as key from chat_membership_events`)).rows[0];
      expect(row.dedupe_key_storage).toEqual(expected);
      expect(row.key).toEqual(expected);
      await client.query("rollback");
    } finally { await client.query("rollback"); client.release(); }
    expect((await pool.query("select octet_length(dedupe_key_storage) as size from chat_membership_events")).rows[0].size).toBe(0);
    await pool.query("update chat_membership_events set chatter_login='renamed',event_at=event_at+interval '1 second'");
    expect((await pool.query(`select ${logicalKey} as key from chat_membership_events`)).rows[0].key).toEqual(expected);
    await expect(pool.query("insert into chat_membership_events(broadcaster_user_id,event_type,dedupe_key_storage) values ('channel','join',$1)", [expected])).rejects.toThrow("chat_membership_events_dedupe_key_idx");
  });

  it("supports index restoration and identity updates with pg_restore's empty search path", async () => {
    const expected = key("person", "2026-09-15T10:12:13Z");
    await pool.query("insert into chat_membership_events(broadcaster_user_id,chatter_login,event_type,event_at,dedupe_key_storage) values ('channel','person','join','2026-09-15T10:12:13Z',$1)", [expected]);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local search_path = ''");
      await client.query(`create index membership_restore_probe on public.chat_membership_events
        (public.read_membership_key(broadcaster_user_id,twitch_stream_id,event_type,chatter_login,event_at,dedupe_key_storage))`);
      const row = (await client.query("update public.chat_membership_events set chatter_login=null returning dedupe_key_storage")).rows[0];
      expect(row.dedupe_key_storage).toEqual(expected);
      const context = (await client.query("select public.get_raw_irc_context('restore-fixture',null,null) as id")).rows[0];
      expect(context.id).toBeTypeOf("number");
      expect((await client.query("select public.get_raw_irc_context('restore-fixture',null,null) as id")).rows[0].id).toBe(context.id);
      await client.query("rollback");
    } finally { await client.query("rollback"); client.release(); }
  });

  it("normalizes exact context values including nulls and reuses them under concurrent first writes", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => pool.query("select get_raw_irc_context($1,null,null) as id", ["room:ää😀"])));
    expect(new Set(results.map((result) => result.rows[0].id)).size).toBe(1);
    const id = results[0]!.rows[0].id;
    const [raw] = await db.insert(rawIrcMessages).values({ rawLine: "synthetic", contextId: id }).returning();
    const metadata = (await pool.query("select c.channel_login,c.bot_account_id,c.irc_connection_id from raw_irc_messages r join raw_irc_contexts c on c.id=r.context_id where r.id=$1", [raw!.id])).rows[0];
    expect(metadata).toEqual({ channel_login: "room:ää😀", bot_account_id: null, irc_connection_id: null });
    expect((await pool.query("select get_raw_irc_context(null,null,null) as id")).rows[0].id).toBeNull();
    expect((await pool.query("select get_raw_irc_context('',null,null) as id")).rows[0].id).not.toBe(id);
    await expect(pool.query("update raw_irc_contexts set channel_login='different' where id=$1", [id])).rejects.toThrow("immutable");
    await expect(pool.query("delete from raw_irc_contexts where id=$1", [id])).rejects.toThrow("foreign key");
  });

  it("retains bot and connection foreign keys and rolls back context creation with an event", async () => {
    const bot = (await pool.query("insert into bot_accounts(login,twitch_user_id) values ('fixture','person') returning id")).rows[0];
    const connection = (await pool.query("insert into irc_connections(bot_account_id) values ($1) returning id", [bot.id])).rows[0];
    const client = await pool.connect();
    try {
      await client.query("begin");
      const row = (await client.query("select get_raw_irc_context(null,$1,$2) as id", [bot.id, connection.id])).rows[0];
      expect((await client.query("select bot_account_id,irc_connection_id from raw_irc_contexts where id=$1", [row.id])).rows[0])
        .toEqual({ bot_account_id: bot.id, irc_connection_id: connection.id });
      await client.query("rollback");
    } finally { await client.query("rollback"); client.release(); }
    expect((await pool.query("select count(*)::int as count from raw_irc_contexts")).rows[0].count).toBe(0);
    await expect(db.insert(rawIrcMessages).values({ rawLine: "synthetic", contextId: sql`get_raw_irc_context('room','00000000-0000-0000-0000-000000000099',null)` })).rejects.toThrow();
    await expect(db.insert(rawIrcMessages).values({ rawLine: "synthetic", contextId: sql`get_raw_irc_context('room',${bot.id}::uuid,'00000000-0000-0000-0000-000000000099')` })).rejects.toThrow();
  });
});
