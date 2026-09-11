import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, rawIrcLineSql, rawIrcMessages, readRawIrcLines } from "./index.js";

const url = process.env.TEST_DATABASE_URL;
if (url != null && !new URL(url).pathname.toLowerCase().includes("test")) throw new Error("TEST_DATABASE_URL must name a dedicated test database.");
const database = url == null ? null : createDb(url);

describe.skipIf(database == null)("Lossless raw IRC blocks with PostgreSQL", () => {
  if (database == null) return;
  const { db, pool } = database;
  beforeEach(async () => { await pool.query("truncate table raw_irc_payload_blocks cascade"); });
  afterAll(async () => { await pool.end(); });
  const lines = ["@id=one :user!user@host PRIVMSG #room :Hei ääkköset 😀 \\ ; :", "@source-room-id=12;id=two :user PRIVMSG #room :relay", ":person!person@host JOIN #room", "", "line\nwith\tcontrols"];
  const seed = async () => {
    for (const line of lines) await pool.query("insert into raw_irc_messages (raw_line, received_at) values ($1, '2026-01-01 00:00:00.123456+00')", [line]);
  };

  it("preserves exact lines, metadata, timestamps and IDs across bounded batches", async () => {
    await seed();
    const original = await pool.query("select to_jsonb(r) as row from raw_irc_messages r order by id");
    expect((await pool.query("select compact_raw_irc_batch(now(), 2) as count")).rows[0].count).toBe(2);
    const ids = original.rows.map((row) => row.row.id as string);
    expect(await readRawIrcLines(db, [...ids, ids[0]!])).toEqual(new Map(original.rows.map((row) => [row.row.id, row.row.raw_line])));
    expect(await readRawIrcLines(db, [])).toEqual(new Map());
    expect((await pool.query("select compact_raw_irc_batch(now(), 256) as count")).rows[0].count).toBe(2);
    expect((await pool.query("select compact_raw_irc_batch(now(), 256) as count")).rows[0].count).toBe(0);
    const restored = await pool.query(`select (to_jsonb(r) - 'payload_block_id' - 'payload_position' - 'unrelayed_source') ||
      jsonb_build_object('raw_line', read_raw_irc_line(raw_line, payload_block_id, payload_position),
        'payload_block_id', null, 'payload_position', null, 'unrelayed_source', null) as row from raw_irc_messages r order by id`);
    expect(restored.rows).toEqual(original.rows);
    expect((await db.select({ line: rawIrcLineSql }).from(rawIrcMessages)).map((row) => row.line).sort()).toEqual([...lines].sort());
    const known = await pool.query("select unrelayed_source from raw_irc_messages where payload_block_id is not null and read_raw_irc_line(raw_line,payload_block_id,payload_position) like '@id=one%'");
    expect(known.rows[0].unrelayed_source).toBe(true);
  });

  it("rolls back locators and blocks together, and skips locked rows", async () => {
    await seed();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select id from raw_irc_messages for update");
      expect((await pool.query("select compact_raw_irc_batch(now()) as count")).rows[0].count).toBe(0);
      expect((await client.query("select compact_raw_irc_batch(now()) as count")).rows[0].count).toBe(4);
      await client.query("rollback");
      expect((await pool.query("select count(*)::int as count from raw_irc_payload_blocks")).rows[0].count).toBe(0);
      expect((await pool.query("select count(*)::int as count from raw_irc_messages where payload_block_id is not null")).rows[0].count).toBe(0);
    } finally { await client.query("rollback"); client.release(); }
  });

  it("removes packed text on redaction and deletion without changing neighbours", async () => {
    await seed();
    await pool.query("select compact_raw_irc_batch(now())");
    const target = (await pool.query("select id,payload_block_id,payload_position from raw_irc_messages where unrelayed_source is true")).rows[0];
    const before = (await pool.query("select lines from raw_irc_payload_blocks where id=$1", [target.payload_block_id])).rows[0].lines;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("update raw_irc_messages set raw_line='[redacted by subject data deletion]',tags='{}'::jsonb where id=$1", [target.id]);
      expect((await client.query("select lines[$2::int] as line from raw_irc_payload_blocks where id=$1", [target.payload_block_id, target.payload_position])).rows[0].line).toBeNull();
      await client.query("rollback");
      expect((await pool.query("select lines from raw_irc_payload_blocks where id=$1", [target.payload_block_id])).rows[0].lines).toEqual(before);
    } finally { await client.query("rollback"); client.release(); }
    await pool.query("update raw_irc_messages set raw_line='[redacted by subject data deletion]' where id=$1", [target.id]);
    const after = (await pool.query("select lines from raw_irc_payload_blocks where id=$1", [target.payload_block_id])).rows[0].lines;
    expect(after).toEqual(before.map((line: string, index: number) => index + 1 === target.payload_position ? null : line));
    const deleted = (await pool.query("delete from raw_irc_messages where payload_block_id is not null returning payload_block_id,payload_position")).rows;
    for (const row of deleted) expect((await pool.query("select lines[$2::int] as line from raw_irc_payload_blocks where id=$1", [row.payload_block_id, row.payload_position])).rows[0].line).toBeNull();
  });

  it("clears an archived line when explicitly replaced with an empty string", async () => {
    await seed();
    await pool.query("select compact_raw_irc_batch(now())");
    const target = (await pool.query("select id,payload_block_id,payload_position from raw_irc_messages where unrelayed_source is true")).rows[0];
    await pool.query("update raw_irc_messages set raw_line='' where id=$1", [target.id]);
    const row = (await pool.query("select raw_line,payload_block_id,payload_position,unrelayed_source from raw_irc_messages where id=$1", [target.id])).rows[0];
    expect(row).toEqual({ raw_line: "", payload_block_id: null, payload_position: null, unrelayed_source: null });
    expect((await pool.query("select lines[$2::int] as line from raw_irc_payload_blocks where id=$1", [target.payload_block_id, target.payload_position])).rows[0].line).toBeNull();
  });

  it("fails closed on an invalid locator and rejects invalid batch sizes", async () => {
    await seed();
    await expect(pool.query("select compact_raw_irc_batch(now(), 0)")).rejects.toThrow("batch size");
    await expect(pool.query("select compact_raw_irc_batch(now(), null)")).rejects.toThrow("batch size");
    await expect(pool.query("select read_raw_irc_line('', 9223372036854775807, 1::smallint)")).rejects.toThrow("Missing raw IRC payload");
    await pool.query("select compact_raw_irc_batch(now())");
    await expect(pool.query("update raw_irc_messages set payload_position=256 where payload_block_id is not null")).rejects.toThrow("Cannot change");
    const ids = (await pool.query("select id from raw_irc_messages")).rows.map((row) => row.id as string);
    await pool.query("update raw_irc_payload_blocks set lines[1]=null");
    await expect(readRawIrcLines(db, ids)).rejects.toThrow("Missing archived IRC payload");
  });
});
