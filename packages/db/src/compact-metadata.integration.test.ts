import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { chatMessages, chatMembershipEvents, createDb, rawIrcMessages } from "./index.js";
import { compactBadgeKeys, decodeCompactJson, encodeCompactJson } from "./compact-metadata.js";

const url = process.env.TEST_DATABASE_URL;
if (url != null && !new URL(url).pathname.toLowerCase().includes("test")) throw new Error("TEST_DATABASE_URL must name a dedicated test database.");
const database = url == null ? null : createDb(url);

describe.skipIf(database == null)("Compact metadata with PostgreSQL", () => {
  if (database == null) return;
  const { db, pool } = database;
  beforeEach(async () => {
    await pool.query("truncate table twitch_users cascade");
    await pool.query("insert into twitch_users(twitch_user_id) values ('metadata-channel')");
  });
  afterAll(async () => { await pool.end(); });

  it.each([
    {}, { raw: "" }, { raw: "\ufeff😀 ä" }, { subscriber: "12", premium: "1" },
    { artist: "\ufeff😀" }, { subscriber: "x".repeat(256) },
    { custom: "badge", nested: [1, true, null] }, [], null, "text", 42
  ].map((value, index) => ({ value, index })))("cross-decodes SQL and JavaScript fixture $index", async ({ value }) => {
    const row = (await pool.query("select encode_compact_json($1::jsonb) as encoded,decode_compact_json($2::bytea) as decoded,decode_compact_json(encode_compact_json($1::jsonb))=$1::jsonb as sql_equal", [JSON.stringify(value), encodeCompactJson(value)])).rows[0];
    expect(row.sql_equal).toBe(true);
    expect(row.decoded).toEqual(value);
    expect(decodeCompactJson(row.encoded)).toEqual(value);
  });

  it("preserves ORM reads, writes, labels, defaults and unknown metadata", async () => {
    const [raw] = await db.insert(rawIrcMessages).values({ rawLine: "synthetic", parsedCommand: "PRIVMSG", tags: { unusual: "😀" } }).returning();
    expect(raw).toMatchObject({ parsedCommand: "PRIVMSG", tags: { unusual: "😀" } });
    const [message] = await db.insert(chatMessages).values({ twitchMessageId: "metadata-message", broadcasterUserId: "metadata-channel", badges: { subscriber: "12" }, emotes: { raw: "" }, rawIrcMessageId: raw!.id }).returning();
    expect(message).toMatchObject({ badges: { subscriber: "12" }, emotes: { raw: "" } });
    for (const source of ["irc_membership", "", "!custom", "future source 😀"]) {
      const [event] = await db.insert(chatMembershipEvents).values({ broadcasterUserId: "metadata-channel", eventType: "join", source }).returning();
      expect(event!.source).toBe(source);
    }
    const [defaultEvent] = await db.insert(chatMembershipEvents).values({ broadcasterUserId: "metadata-channel", eventType: "part" }).returning();
    expect(defaultEvent!.source).toBe("irc_membership");
    const [defaultMessage] = await db.insert(chatMessages).values({ twitchMessageId: "defaults", broadcasterUserId: "metadata-channel" }).returning();
    expect(defaultMessage).toMatchObject({ badges: {}, emotes: {} });
    for (const parsedCommand of [null, "", "NOTICE", "!future", "future 😀"]) {
      const [record] = await db.insert(rawIrcMessages).values({ rawLine: "synthetic", parsedCommand }).returning();
      expect(record!.parsedCommand).toBe(parsedCommand);
    }
  });

  it("keeps every permanent badge code identical between SQL and JavaScript", async () => {
    const value = Object.fromEntries(compactBadgeKeys.map((key, index) => [key, `${index}:😀`]));
    const row = (await pool.query("select encode_compact_json($1::jsonb) as encoded,decode_compact_json($2::bytea) as decoded", [JSON.stringify(value), encodeCompactJson(value)])).rows[0];
    expect(row.encoded).toEqual(encodeCompactJson(value));
    expect(row.decoded).toEqual(value);
  });

  it("rejects corrupt encodings and preserves PostgreSQL numeric precision", async () => {
    await expect(pool.query("insert into raw_irc_messages(raw_line,tags) values ('synthetic',decode('0301000100','hex'))")).rejects.toThrow();
    const row = (await pool.query("select decode_compact_json(encode_compact_json('{\"n\":123456789012345678901234567890}'::jsonb)) = '{\"n\":123456789012345678901234567890}'::jsonb as equal")).rows[0];
    expect(row.equal).toBe(true);
  });
});
