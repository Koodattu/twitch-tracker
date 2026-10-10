import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { chatMessages, createDb, rawIrcMessages, streamSessions, streamSnapshots, twitchUsers } from "./index.js";
import { encodeExternalKey } from "./compact-external-key.js";

const url = process.env.TEST_DATABASE_URL;
if (url != null && !new URL(url).pathname.toLowerCase().includes("test")) throw new Error("TEST_DATABASE_URL must name a dedicated test database.");
const database = url == null ? null : createDb(url);

describe.skipIf(database == null)("Compact native records with PostgreSQL", () => {
  if (database == null) return;
  const { db, pool } = database;
  beforeEach(async () => { await pool.query("truncate twitch_users, raw_irc_records cascade"); });
  afterAll(async () => { await pool.end(); });

  it("cross-decodes keys and keeps distinct spellings, foreign keys and deduplication", async () => {
    const ids = ["0", "123", "000123", "4294967295", "4294967296", "281474976710655", "281474976710656", "opaque 😀", "\ufeff123", ""];
    for (const id of ids) {
      const { rows } = await pool.query("select encode_external_key($1) as bytes, decode_external_key($2) as value", [id, encodeExternalKey(id)]);
      expect(rows[0]).toEqual({ bytes: encodeExternalKey(id), value: id });
      await db.insert(twitchUsers).values({ twitchUserId: id });
      await db.insert(chatMessages).values({ twitchMessageId: id, broadcasterUserId: id, chatterUserId: id, sharedChatSourceChannelId: id });
      expect((await db.select().from(chatMessages).where(eq(chatMessages.chatterUserId,id)))[0]).toMatchObject({ twitchMessageId:id, broadcasterUserId:id, chatterUserId:id, sharedChatSourceChannelId:id });
    }
    expect(await db.insert(chatMessages).values({ twitchMessageId:"123", broadcasterUserId:"123" }).onConflictDoNothing().returning()).toEqual([]);
    await expect(db.insert(chatMessages).values({ twitchMessageId:"missing", broadcasterUserId:"missing" })).rejects.toThrow();
    await expect(pool.query("select decode_external_key(decode('02313233','hex'))")).rejects.toThrow("Noncanonical");
    for (const hex of ["", "00", "01000000000001", "02ff", "03"]) {
      await expect(pool.query("select decode_external_key(decode($1,'hex'))",[hex])).rejects.toThrow();
    }
  });

  it("preserves microseconds, delta boundaries, infinities, BC dates and distant dates in every time zone", async () => {
    const client = await pool.connect();
    try {
      for (const zone of ["UTC", "Europe/Helsinki", "America/New_York"]) {
        await client.query("select set_config('TimeZone',$1,false)",[zone]);
        const { rows } = await client.query(`with times as (
          select a,c from unnest(array['2026-03-29 00:59:59.123456Z','infinity','-infinity','4713-01-01 BC','294000-01-01Z']::timestamptz[]) a
          cross join unnest(array['2026-03-29 01:00:00.000001Z','infinity','-infinity','4713-01-01 BC','294000-01-01Z']::timestamptz[]) c
          union all select now(),now()+n*interval '1 microsecond'
          from unnest(array[-2147483649,-2147483648,-1,0,1,2147483647,2147483648]::bigint[]) n
        ) select count(*)::int as n from times where unpack_record_time(pack_record_time(a,c),a) is distinct from c`);
        expect(rows[0].n).toBe(0);
      }
    } finally { await client.query("set time zone 'UTC'"); client.release(); }
  });

  it("keeps defaults, labels, viewer metadata, native upserts and mutations through the views", async () => {
    await db.insert(twitchUsers).values({ twitchUserId:"123" });
    await db.insert(streamSessions).values({ twitchStreamId:"12345678901", broadcasterUserId:"123", startedAt:new Date() });
    const [raw] = await db.insert(rawIrcMessages).values({ rawLine:"synthetic", receivedAt:new Date("2026-01-01") }).returning();
    expect(raw!.createdAt.getTime()).toBeGreaterThan(raw!.receivedAt.getTime());
    expect(raw!.updatedAt).toEqual(raw!.createdAt);
    for (const label of ["irc", "privmsg", "", "!custom", "Unicode 😀"]) {
      const [chat] = await db.insert(chatMessages).values({ twitchMessageId:label, broadcasterUserId:"123", source:label, messageType:label }).returning();
      expect(chat).toMatchObject({ source:label, messageType:label });
      expect(chat!.updatedAt).toEqual(chat!.createdAt);
    }
    const [snapshot] = await db.insert(streamSnapshots).values({ twitchStreamId:"12345678901", broadcasterUserId:"123", tags:["fi","😀"] }).returning();
    expect(snapshot!.tags).toEqual(["fi","😀"]);
    const snapshotTimes = (await pool.query("select created_at::text,updated_at::text from stream_snapshots where id=$1",[snapshot!.id])).rows;
    await pool.query("update stream_snapshots set observed_at=observed_at+interval '1 day' where id=$1",[snapshot!.id]);
    expect((await pool.query("select created_at::text,updated_at::text from stream_snapshots where id=$1",[snapshot!.id])).rows).toEqual(snapshotTimes);
    const before = (await pool.query("select created_at::text,updated_at::text from raw_irc_messages where id=$1",[raw!.id])).rows;
    await db.update(rawIrcMessages).set({ receivedAt:new Date("2025-01-01") }).where(eq(rawIrcMessages.id,raw!.id));
    expect((await pool.query("select created_at::text,updated_at::text from raw_irc_messages where id=$1",[raw!.id])).rows).toEqual(before);
    await db.execute(sql`update raw_irc_records set updated_at='2026-10-10 00:00:00.123456Z' where id=${raw!.id}`);
    expect((await pool.query("select created_at::text,updated_at::text from raw_irc_messages where id=$1",[raw!.id])).rows[0]).toEqual({ created_at:before[0].created_at, updated_at:"2026-10-10 00:00:00.123456+00" });
  });

  it("retains native concurrent deduplication and rejects malformed physical metadata", async () => {
    await db.insert(twitchUsers).values({ twitchUserId:"123" });
    const results = await Promise.all([0,1].map(()=>db.insert(chatMessages).values({ twitchMessageId:"race", broadcasterUserId:"123" }).onConflictDoNothing().returning()));
    expect(results.flat()).toHaveLength(1);
    await expect(pool.query("update chat_message_records set record_times=decode('01','hex')")).rejects.toThrow("chat_record_times_shape");
  });
});
