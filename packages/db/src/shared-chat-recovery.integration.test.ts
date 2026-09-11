import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl != null && !new URL(testDatabaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("TEST_DATABASE_URL must name a dedicated test database.");
}
const database = testDatabaseUrl == null ? null : createDb(testDatabaseUrl);

describe.skipIf(database == null)("Shared Chat source recovery with PostgreSQL", () => {
  if (database == null) return;
  const { pool } = database;
  beforeEach(async () => { await pool.query("truncate table twitch_users, raw_irc_messages cascade"); });
  afterAll(async () => { await pool.end(); });

  it("recovers source tags without changing existing sources, deleted subjects, or ordinary messages", async () => {
    await pool.query("insert into twitch_users (twitch_user_id) values ('channel'), ('chatter')");
    const fixtures = [
      { id: "relay", line: "@id=relay;source-room-id=100;user-id=chatter :chatter PRIVMSG #channel :Hello", source: null, expected: "100" },
      { id: "first-tag", line: "@source-room-id=200;id=first-tag :chatter PRIVMSG #channel :Hello", source: null, expected: "200" },
      { id: "last-tag", line: "@id=last-tag;source-room-id=300 :chatter PRIVMSG #channel :Hello", source: null, expected: "300" },
      { id: "existing", line: "@id=existing;source-room-id=100 :chatter PRIVMSG #channel :Hello", source: "999", expected: "999" },
      { id: "ordinary", line: "@id=ordinary :chatter PRIVMSG #channel :source-room-id=100", source: null, expected: null },
      { id: "empty", line: "@source-room-id=;id=empty :chatter PRIVMSG #channel :Hello", source: null, expected: null },
      { id: "redacted", line: "[redacted by subject data deletion]", source: null, expected: null },
      { id: "deleted", line: "@source-room-id=100;id=deleted :chatter PRIVMSG #channel :Hello", source: null, expected: null }
    ].map((fixture) => ({ ...fixture, messageId: randomUUID() }));
    for (const fixture of fixtures) {
      const raw = await pool.query("insert into raw_irc_messages (raw_line) values ($1) returning id", [fixture.line]);
      await pool.query(`insert into chat_messages (twitch_message_id, broadcaster_user_id, chatter_user_id, shared_chat_source_channel_id, raw_irc_message_id)
        values (encode_chat_message_id($1), 'channel', $2, $3, $4)`, [fixture.messageId, fixture.id === "deleted" ? null : "chatter", fixture.source, raw.rows[0].id]);
    }
    const migration = await readFile(new URL("../migrations/0012_recover_shared_chat_sources.sql", import.meta.url), "utf8");
    const first = await pool.query(migration);
    expect(first.rowCount).toBe(3);
    const result = await pool.query("select decode_chat_message_id(twitch_message_id) as twitch_message_id, shared_chat_source_channel_id from chat_messages");
    expect(Object.fromEntries(result.rows.map((row) => [row.twitch_message_id, row.shared_chat_source_channel_id])))
      .toEqual(Object.fromEntries(fixtures.map((fixture) => [fixture.messageId, fixture.expected])));
    const repeat = await pool.query(migration);
    expect(repeat.rowCount).toBe(0);
  });
});
