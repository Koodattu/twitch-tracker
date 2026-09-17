import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { chatMembershipEvents, chatMessages, createDb } from "./index.js";

const url = process.env.TEST_DATABASE_URL;
if (url != null && !new URL(url).pathname.toLowerCase().includes("test")) throw new Error("TEST_DATABASE_URL must name a dedicated test database.");
const database = url == null ? null : createDb(url);

describe.skipIf(database == null)("Compact identifiers with PostgreSQL", () => {
  if (database == null) return;
  const { db, pool } = database;
  beforeEach(async () => {
    await pool.query("truncate table twitch_users cascade");
    await pool.query("insert into twitch_users (twitch_user_id) values ('channel')");
  });
  afterAll(async () => { await pool.end(); });

  it("preserves every SHA-256 bit, the application string, and uniqueness", async () => {
    const digest = createHash("sha256").update("membership fixture").digest();
    const value = { broadcasterUserId: "channel", eventType: "join" as const, dedupeKeyStorage: digest.toString("base64url") };
    const first = await db.insert(chatMembershipEvents).values(value).returning();
    expect(first[0]!.dedupeKeyStorage).toBe(value.dedupeKeyStorage);
    expect((await pool.query("select dedupe_key_storage from chat_membership_events")).rows[0].dedupe_key_storage).toEqual(digest);
    expect((await pool.query("select * from insert_membership_event('channel',null,null,null,'join',null,null,$1)", [digest])).rows).toEqual([]);
    await expect(db.insert(chatMembershipEvents).values({ ...value, dedupeKeyStorage: "not-a-digest" }).returning()).rejects.toThrow("canonical SHA-256");
  });

  it.each(["00112233-4455-6677-8899-aabbccddeeff", "an-opaque-ID/😀", "00112233-4455-6677-8899-AABBCCDDEEFF", ""])("preserves external identifier %s and deduplication", async (messageId) => {
    const value = { twitchMessageId: messageId, replyParentMessageId: "opaque-parent", broadcasterUserId: "channel" };
    expect((await db.insert(chatMessages).values(value).returning())[0]).toMatchObject(value);
    expect(await db.insert(chatMessages).values(value).onConflictDoNothing().returning()).toEqual([]);
    const stored = (await pool.query("select decode_chat_message_id(twitch_message_id) as decoded, twitch_message_id, encode_chat_message_id($1) as expected from chat_messages", [messageId])).rows[0];
    expect(stored.decoded).toBe(messageId);
    expect(stored.twitch_message_id).toEqual(stored.expected);
    if (messageId === "00112233-4455-6677-8899-aabbccddeeff") expect(stored.twitch_message_id.length).toBe(17);
  });

  it("rejects alternate binary encodings that would bypass message deduplication", async () => {
    const messageId = "00112233-4455-6677-8899-aabbccddeeff";
    await db.insert(chatMessages).values({ twitchMessageId: messageId, broadcasterUserId: "channel" });
    await expect(pool.query(`insert into chat_messages (twitch_message_id, broadcaster_user_id)
      values (decode('01', 'hex') || convert_to($1, 'UTF8'), 'channel')`, [messageId])).rejects.toThrow("chat_message_id_encoding");
  });
});
