import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret, hashSessionToken, loadConfig } from "@twitch-tracker/config";
import { appUsers, channelDailyStats, channelEvents, chatMembershipEvents, chatMessages, chatPresenceSnapshots, createDb, oauthAccounts, raids, rawEventsubEvents, sessions, streamActivityBuckets, streamSessions, streamSnapshots, subjectPrivacyStates, twitchUsers } from "@twitch-tracker/db";
import { eq } from "drizzle-orm";
import { createApiApp } from "./routes.js";
import { HTTPException } from "hono/http-exception";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl != null && !new URL(testDatabaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("TEST_DATABASE_URL must name a dedicated test database.");
}
const database = testDatabaseUrl == null ? null : createDb(testDatabaseUrl);

describe.skipIf(database == null)("Analytics routes with PostgreSQL", () => {
  if (database == null) {
    return;
  }

  const { db, pool } = database;
  const config = loadConfig({ DATABASE_URL: testDatabaseUrl, SESSION_SECRET: "s".repeat(48) });
  const app = createApiApp({ config, db });
  const firstSeen = new Date("2026-09-05T10:00:00.000Z");
  const latestSeen = new Date("2026-09-05T10:03:00.000Z");
  const sessionToken = "analytics-test-session";
  const headers = { Cookie: `twitch_tracker_session=${sessionToken}` };

  beforeEach(async () => {
    await pool.query("truncate table twitch_users cascade");
    await db.insert(twitchUsers).values([
      { twitchUserId: "broadcaster", login: "channel" },
      { twitchUserId: "chatter", login: "chatter" }
    ]);
    await db.insert(streamSessions).values({
      twitchStreamId: "stream",
      broadcasterUserId: "broadcaster",
      startedAt: firstSeen,
      firstSeenAt: firstSeen,
      lastSeenLiveAt: latestSeen,
      language: "fi",
      isFinnishEligible: true
    });
    const [user] = await db.insert(appUsers).values({ twitchUserId: "chatter" }).returning();
    if (user == null) {
      throw new Error("Failed to create test user.");
    }
    await db.insert(sessions).values({
      sessionIdHash: hashSessionToken(sessionToken, config.SESSION_SECRET),
      appUserId: user.id,
      expiresAt: new Date(Date.now() + 3_600_000)
    });
    await db.insert(oauthAccounts).values({
      appUserId: user.id,
      providerUserId: "chatter",
      encryptedAccessToken: encryptSecret("synthetic-test-token", config.SESSION_SECRET),
      lastValidatedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000)
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    "/api/streams/recent?limit=bad",
    "/api/channels?page=0",
    "/api/channels?page=1.5",
    "/api/channels?page=100001",
    `/api/channels?q=${"a".repeat(101)}`,
    "/api/channels/channel/streams?limit=51",
    "/api/channels/channel/viewer-history?limit=501",
    "/api/channels/channel/activity?days=0"
  ])("reports invalid query input as a client error: %s", async (path) => {
    const response = await app.request(path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: "Check the request parameters." } });
  });

  it("keeps HTTP error responses and logs unexpected failures without input or error details", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const errorApp = createApiApp({ config, db });
    errorApp.get("/test/failure/:identity", () => { throw new Error("synthetic-sensitive-database-value"); });
    errorApp.get("/test/http-error", () => { throw new HTTPException(429, { res: new Response("Please retry later", { status: 429, headers: { "Retry-After": "60" } }) }); });
    try {
      const response = await errorApp.request("/test/failure/synthetic-identity?token=synthetic-sensitive-token");
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal Server Error");
      expect(errors).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ level: "error", message: "API request failed", method: "GET", route: "/test/failure/:identity", errorType: "Error" }));
      const limited = await errorApp.request("/test/http-error");
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Retry-After")).toBe("60");
      expect(await limited.text()).toBe("Please retry later");
    } finally { errors.mockRestore(); }
  });

  it("returns packed raw lines and erases their archived copies through the privacy API", async () => {
    const wire = "@id=00112233-4455-6677-8899-aabbccddeeff :chatter PRIVMSG #channel :private fixture";
    const raw = (await pool.query("insert into raw_irc_messages (raw_line, received_at,context_id) values ($1,$2,get_raw_irc_context('channel',null,null)) returning id", [wire, firstSeen])).rows[0];
    await db.insert(chatMessages).values({ twitchMessageId: "00112233-4455-6677-8899-aabbccddeeff",
      broadcasterUserId: "broadcaster", chatterUserId: "chatter", chatterLogin: "chatter", twitchStreamId: "stream", rawIrcMessageId: raw.id });
    const membership = (await pool.query(`insert into chat_membership_events
      (broadcaster_user_id,chatter_user_id,chatter_login,twitch_stream_id,event_type,event_at,dedupe_key_storage)
      values ('broadcaster','chatter','chatter','stream','join',$1,derive_membership_key('broadcaster','stream','join','chatter',$1))
      returning id,read_membership_key(broadcaster_user_id,twitch_stream_id,event_type,chatter_login,event_at,dedupe_key_storage) as key,octet_length(dedupe_key_storage) as stored_bytes`, [firstSeen])).rows[0];
    expect(membership.stored_bytes).toBe(0);
    await pool.query("select compact_raw_irc_batch(now())");
    const response = await app.request("/api/private/streams/stream/raw");
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("private fixture");
    await db.update(appUsers).set({ isAdmin: true }).where(eq(appUsers.twitchUserId, "chatter"));
    const request = (await pool.query("insert into privacy_requests (request_type,subject_twitch_user_id) values ('data_deletion','chatter') returning id")).rows[0];
    const completed = await app.request(`/api/internal/privacy-requests/${request.id}/complete`, { method: "POST", headers });
    expect(completed.status).toBe(200);
    expect((await pool.query("select count(*)::int as count from raw_irc_payload_blocks where $1=any(lines)", [wire])).rows[0].count).toBe(0);
    expect((await pool.query("select read_raw_irc_line(raw_line,payload_block_id,payload_position) as line from raw_irc_messages where id=$1", [raw.id])).rows[0].line).toBe("[redacted by subject data deletion]");
    const redactedMembership = (await pool.query(`select chatter_user_id,chatter_login,
      read_membership_key(broadcaster_user_id,twitch_stream_id,event_type,chatter_login,event_at,dedupe_key_storage) as key
      from chat_membership_events where id=$1`, [membership.id])).rows[0];
    expect(redactedMembership).toEqual({ chatter_user_id: null, chatter_login: null, key: membership.key });
    expect((await pool.query("select count(*)::int as n from membership_event_identities where chatter_user_id='chatter' or chatter_login='chatter'")).rows[0].n).toBe(0);
  });

  it.each([null, "https://example.com/current.jpg"])("returns the latest viewer sample with thumbnail %s", async (thumbnailUrl) => {
    await db.insert(streamSnapshots).values([
      {
        twitchStreamId: "stream", broadcasterUserId: "broadcaster", observedAt: firstSeen,
        viewerCount: 10, title: "Stream title", thumbnailUrl: "https://example.com/previous.jpg"
      },
      {
        twitchStreamId: "stream", broadcasterUserId: "broadcaster", observedAt: latestSeen,
        viewerCount: 25, title: thumbnailUrl == null ? null : "New title", thumbnailUrl
      }
    ]);

    const response = await app.request("/api/streams/live");
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([
      expect.objectContaining({
        streamId: "stream", viewerCount: 25, viewerObservedAt: latestSeen.toISOString(),
        thumbnailUrl: thumbnailUrl ?? "https://example.com/previous.jpg"
      })
    ]);
  });

  it("returns a live stream without a snapshot", async () => {
    const response = await app.request("/api/streams/live");
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([
      expect.objectContaining({ streamId: "stream", viewerCount: null, viewerObservedAt: null, thumbnailUrl: null })
    ]);
  });

  it("keeps thumbnail metadata tied to its stream", async () => {
    await db.insert(streamSessions).values({
      twitchStreamId: "other-stream", broadcasterUserId: "chatter", startedAt: firstSeen,
      isFinnishEligible: true
    });
    await db.insert(streamSnapshots).values([
      { twitchStreamId: "stream", broadcasterUserId: "broadcaster", observedAt: firstSeen,
        title: "Original", thumbnailUrl: "https://example.com/original.jpg" },
      { twitchStreamId: "stream", broadcasterUserId: "broadcaster", observedAt: latestSeen,
        viewerCount: 25 },
      { twitchStreamId: "other-stream", broadcasterUserId: "chatter", observedAt: latestSeen,
        title: "Other", thumbnailUrl: "https://example.com/other.jpg" }
    ]);

    const response = await app.request("/api/streams/live");
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(expect.arrayContaining([
      expect.objectContaining({ streamId: "stream", thumbnailUrl: "https://example.com/original.jpg" }),
      expect.objectContaining({ streamId: "other-stream", thumbnailUrl: "https://example.com/other.jpg" })
    ]));
  });

  it("returns every eligible live stream, including those below rank 100", async () => {
    await db.insert(streamSessions).values(Array.from({ length: 105 }, (_, index) => ({
      twitchStreamId: `stream-${index}`, broadcasterUserId: "broadcaster", startedAt: firstSeen,
      isFinnishEligible: true
    })));
    const response = await app.request("/api/streams/live");
    expect(response.status).toBe(200);
    expect((await response.json()).data).toHaveLength(106);
  });

  it("excludes ended, ineligible, and suppressed streams from public totals", async () => {
    await db.insert(streamSessions).values([
      { twitchStreamId: "ended", broadcasterUserId: "broadcaster", startedAt: firstSeen, endedAt: latestSeen, isFinnishEligible: true },
      { twitchStreamId: "ineligible", broadcasterUserId: "broadcaster", startedAt: firstSeen, isFinnishEligible: false },
      { twitchStreamId: "hidden", broadcasterUserId: "chatter", startedAt: firstSeen, isFinnishEligible: true }
    ]);
    await db.insert(subjectPrivacyStates).values({ twitchUserId: "chatter", publicProfileHidden: true });
    const response = await app.request("/api/streams/live");
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([expect.objectContaining({ streamId: "stream" })]);
  });

  it("links recent sessions to an archive thumbnail without calling Twitch during listing", async () => {
    await db.update(streamSessions).set({ endedAt: latestSeen }).where(eq(streamSessions.twitchStreamId, "stream"));
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const response = await app.request("/api/streams/recent?status=ended");
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([
      expect.objectContaining({ streamId: "stream", thumbnailUrl: "/api/streams/stream/thumbnail" })
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redirects an ended session thumbnail to its matching Twitch archive", async () => {
    await db.update(streamSessions).set({ endedAt: latestSeen }).where(eq(streamSessions.twitchStreamId, "stream"));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      String(input).includes("id.twitch.tv")
        ? { access_token: "test", expires_in: 3600, token_type: "bearer" }
        : { data: [{ id: "vod", stream_id: "stream", user_id: "broadcaster", viewable: "public", type: "archive",
          thumbnail_url: "https://static-cdn.jtvnw.net/archive-%{width}x%{height}.jpg" }] }
    ))));
    const thumbnailApp = createApiApp({ db, config: { ...config, TWITCH_CLIENT_ID: "test", TWITCH_CLIENT_SECRET: "test" } });
    const response = await thumbnailApp.request("/api/streams/stream/thumbnail");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://static-cdn.jtvnw.net/archive-640x360.jpg");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("does not expose a suppressed session thumbnail", async () => {
    await db.update(streamSessions).set({ endedAt: latestSeen }).where(eq(streamSessions.twitchStreamId, "stream"));
    await db.insert(subjectPrivacyStates).values({ twitchUserId: "broadcaster", publicProfileHidden: true });
    expect((await app.request("/api/streams/stream/thumbnail")).status).toBe(404);
  });

  it("returns an empty image response when no archive thumbnail is available", async () => {
    await db.update(streamSessions).set({ endedAt: latestSeen }).where(eq(streamSessions.twitchStreamId, "stream"));
    expect((await app.request("/api/streams/stream/thumbnail")).status).toBe(204);
  });

  it("returns an empty overview without loading raw records", async () => {
    const querySpy = vi.spyOn(pool, "query");
    try {
      const response = await app.request("/api/streams/stream/overview");
      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual({
        totals: { viewerCountAvg: null, viewerCountMax: null, messageCount: 0, activeChatterCountMax: null },
        intervalMinutes: 1, points: [], peakAudience: null, busiestChat: null, largestRaid: null, events: []
      });
      const queries = querySpy.mock.calls.map((call) => {
        const query: unknown = call[0];
        return typeof query === "string" ? query : query != null && typeof query === "object" && "text" in query ? String(query.text) : "";
      }).join("\n");
      expect(queries).toContain("stream_activity_buckets");
      expect(queries).not.toMatch(/chat_messages|chat_membership_events|chat_presence_|raw_irc_messages|raw_eventsub_events|stream_snapshots/);
    } finally {
      querySpy.mockRestore();
    }
  });

  it("bounds the chart across a long session while retaining early peaks and totals", async () => {
    await db.insert(streamActivityBuckets).values(Array.from({ length: 601 }, (_, index) => ({
      twitchStreamId: "stream", bucketStart: new Date(firstSeen.getTime() + index * 60_000), bucketMinutes: 1,
      viewerCountAvg: index === 0 ? 900 : 10, viewerCountMax: index === 0 ? 1000 : 12,
      messageCount: index === 0 ? 100 : 2, activeChatterCount: index === 0 ? 30 : 1
    })));
    const response = await app.request("/api/streams/stream/overview");
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.points.length).toBeLessThanOrEqual(300);
    expect(new Date(data.points[0].time).toISOString()).toBe(firstSeen.toISOString());
    expect(new Date(data.points.at(-1).time).getTime()).toBe(firstSeen.getTime() + 600 * 60_000);
    expect(data.points[0].viewerPeak).toBe(1000);
    expect(data.totals).toMatchObject({ viewerCountMax: 1000, messageCount: 1300, activeChatterCountMax: 30 });
    expect(data.peakAudience.viewers).toBe(1000);
    expect(data.busiestChat).toMatchObject({ messages: 100, minutes: 1 });
    expect(data).not.toHaveProperty("messages");
    expect(data).not.toHaveProperty("snapshots");
  });

  it("keeps missing intervals and unobserved chat distinct from zero", async () => {
    await db.insert(streamActivityBuckets).values([
      { twitchStreamId: "stream", bucketStart: firstSeen, bucketMinutes: 1, viewerCountAvg: 10, viewerCountMax: 15 },
      { twitchStreamId: "stream", bucketStart: latestSeen, bucketMinutes: 1, viewerCountAvg: 20, viewerCountMax: 25, messageCount: 3, activeChatterCount: 2 }
    ]);
    const response = await app.request("/api/streams/stream/overview");
    expect(response.status).toBe(200);
    const { points } = (await response.json()).data;
    expect(points).toHaveLength(4);
    expect(points[0]).toMatchObject({ messagesPerMinute: null, interrupted: false });
    expect(points[1]).toMatchObject({ viewers: null, viewerPeak: null, messagesPerMinute: null, activeChatters: null, interrupted: true });
    expect(points[3]).toMatchObject({ viewers: 20, messagesPerMinute: 3, activeChatters: 2, interrupted: true });
  });

  it("finds offline Finnish channels without exposing chatter-only, other-language or suppressed identities", async () => {
    const identities = ["offline", "other", "hidden", "opted", "unnamed"];
    await db.insert(twitchUsers).values(identities.map((id) => ({ twitchUserId: id, login: id === "unnamed" ? null : id, displayName: `${id} channel` })));
    await db.insert(streamSessions).values(identities.map((id) => ({
      twitchStreamId: `${id}-session`, broadcasterUserId: id, startedAt: firstSeen, firstSeenAt: firstSeen,
      lastSeenLiveAt: latestSeen, endedAt: latestSeen, isFinnishEligible: id !== "other", latestTitle: "An earlier broadcast"
    })));
    await db.insert(subjectPrivacyStates).values([
      { twitchUserId: "hidden", publicProfileHidden: true }, { twitchUserId: "opted", trackingOptedOut: true }
    ]);
    const response = await app.request("/api/channels");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const { data } = await response.json();
    expect(data.items.map((item: { login: string }) => item.login)).toEqual(["channel", "offline"]);
    expect(data.items[1]).toMatchObject({ login: "offline", latestStreamId: "offline-session", latestTitle: "An earlier broadcast", endedAt: latestSeen.toISOString() });
    expect(data).toMatchObject({ page: 1, pageSize: 50, hasMore: false });
    const search = await app.request("/api/channels?q=%20OFFLINE%20");
    expect((await search.json()).data.items.map((item: { login: string }) => item.login)).toEqual(["offline"]);
    await db.update(appUsers).set({ isAdmin: true }).where(eq(appUsers.twitchUserId, "chatter"));
    const admin = await app.request("/api/channels", { headers });
    expect((await admin.json()).data.items.map((item: { login: string }) => item.login)).toEqual(["channel", "hidden", "offline", "opted"]);
  });

  it("searches channel names literally and returns the latest Finnish session once per channel", async () => {
    await db.update(twitchUsers).set({ displayName: "100%_Suomi" }).where(eq(twitchUsers.twitchUserId, "broadcaster"));
    await db.insert(streamSessions).values({ twitchStreamId: "older", broadcasterUserId: "broadcaster",
      startedAt: new Date(firstSeen.getTime() - 86_400_000), firstSeenAt: firstSeen, lastSeenLiveAt: firstSeen,
      endedAt: firstSeen, isFinnishEligible: true });
    const response = await app.request("/api/channels?q=100%25_");
    expect(response.status).toBe(200);
    const items = (await response.json()).data.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ login: "channel", latestStreamId: "stream", endedAt: null, latestCategoryName: null });
    // Existing ingestion preserves a Finnish match reason if the language later changes.
    await db.update(streamSessions).set({ isFinnishEligible: false, finnishMatchReason: "language" }).where(eq(streamSessions.twitchStreamId, "stream"));
    expect((await (await app.request("/api/channels")).json()).data.items[0].latestStreamId).toBe("stream");
    for (const q of ["missing", "100_", "' OR 1=1 --"]) {
      const result = await app.request(`/api/channels?${new URLSearchParams({ q })}`);
      expect((await result.json()).data.items).toEqual([]);
    }
  });

  it("paginates matching channels with a stable order and no repeated channels", async () => {
    const ids = Array.from({ length: 52 }, (_, index) => `directory-${String(index).padStart(2, "0")}`);
    await db.insert(twitchUsers).values(ids.map((id) => ({ twitchUserId: id, login: id })));
    await db.insert(streamSessions).values(ids.map((id) => ({ twitchStreamId: `${id}-stream`, broadcasterUserId: id,
      startedAt: latestSeen, firstSeenAt: latestSeen, lastSeenLiveAt: latestSeen, endedAt: latestSeen, isFinnishEligible: true })));
    const first = await app.request("/api/channels?q=directory");
    expect(first.status).toBe(200);
    const firstPage = (await first.json()).data;
    const secondPage = (await (await app.request("/api/channels?q=directory&page=2")).json()).data;
    expect(firstPage).toMatchObject({ page: 1, hasMore: true });
    expect(firstPage.items).toHaveLength(50);
    expect(secondPage).toMatchObject({ page: 2, hasMore: false });
    expect([...firstPage.items, ...secondPage.items].map((item: { login: string }) => item.login)).toEqual(ids);
    expect((await (await app.request("/api/channels?q=directory&page=3")).json()).data.items).toEqual([]);
  });

  it.each(["overview", "activity"])("weights stream audience averages by observed interval length, excluding unknown audience: %s", async (endpoint) => {
    await db.insert(streamActivityBuckets).values([
      { twitchStreamId: "stream", bucketStart: firstSeen, bucketMinutes: 1, viewerCountAvg: 100, viewerCountMax: 120 },
      { twitchStreamId: "stream", bucketStart: new Date(firstSeen.getTime() + 60_000), bucketMinutes: 5, viewerCountAvg: 10, viewerCountMax: 12 },
      { twitchStreamId: "stream", bucketStart: new Date(firstSeen.getTime() + 6 * 60_000), bucketMinutes: 5, messageCount: 25, activeChatterCount: 3 }
    ]);
    const response = await app.request(`/api/streams/stream/${endpoint}`);
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    // One minute at 100 plus five at 10 is 150 viewer-minutes / 6 = 25.
    // The chat-only interval supplies no audience evidence.
    expect(data.totals).toMatchObject({ viewerCountAvg: 25, viewerCountMax: 120, messageCount: 25 });
    if (endpoint === "overview") {
      expect(data.points[0]).toMatchObject({ viewers: 25, viewerPeak: 120, messagesPerMinute: null });
      expect(data.points[1]).toMatchObject({ viewers: null, messagesPerMinute: 5, activeChatters: 3 });
    }
  });

  it("merges raids and events in time order without duplicate EventSub raids", async () => {
    const [raw] = await db.insert(rawEventsubEvents).values({ eventType: "channel.raid", payload: {} }).returning();
    await db.insert(channelEvents).values([
      { twitchStreamId: "stream", eventType: "channel.raid", occurredAt: firstSeen, source: "eventsub", rawEventsubEventId: raw!.id },
      { twitchStreamId: "stream", eventType: "stream.offline", occurredAt: latestSeen, source: "eventsub" }
    ]);
    await db.insert(raids).values({ targetStreamId: "stream", sourceBroadcasterUserId: "chatter", viewerCount: 50, occurredAt: firstSeen, rawEventsubEventId: raw!.id });
    const response = await app.request("/api/streams/stream/events");
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.items.map((item: { eventType: string }) => item.eventType)).toEqual(["stream.offline", "incoming_raid"]);
    expect(data.items[1]).toMatchObject({ actor: "chatter", viewerCount: 50 });
    const overview = await app.request("/api/streams/stream/overview");
    expect((await overview.json()).data.largestRaid.viewers).toBe(50);
  });

  it.each(["observations", "buckets", "events", "messages", "membership", "presence"])("paginates %s independently with a stable tie order", async (kind) => {
    for (let index = 0; index < 51; index++) {
      const shared = { twitchStreamId: "stream", broadcasterUserId: "broadcaster" };
      switch (kind) {
        case "observations": await db.insert(streamSnapshots).values({ ...shared, observedAt: firstSeen }); break;
        case "buckets": await db.insert(streamActivityBuckets).values({ twitchStreamId: "stream", bucketStart: new Date(firstSeen.getTime() + index * 60_000), bucketMinutes: 1 }); break;
        case "events": await db.insert(channelEvents).values({ ...shared, eventType: "stream.online", occurredAt: firstSeen, source: "eventsub" }); break;
        case "messages": await db.insert(chatMessages).values({ ...shared, twitchMessageId: `message-${index}`, receivedAt: firstSeen }); break;
        case "membership": await db.insert(chatMembershipEvents).values({ ...shared, eventType: "join", receivedAt: firstSeen }); break;
        case "presence": await db.insert(chatPresenceSnapshots).values({ ...shared, sampledAt: firstSeen, source: "helix" }); break;
      }
    }
    const prefix = ["messages", "membership", "presence"].includes(kind) ? "/api/private/streams" : "/api/streams";
    const first = await app.request(`${prefix}/stream/${kind}`);
    const second = await app.request(`${prefix}/stream/${kind}?page=2`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstPage = (await first.json()).data;
    const secondPage = (await second.json()).data;
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
    expect(firstPage.items).not.toContainEqual(secondPage.items[0]);
  });

  it("filters chat by exact login and an exclusive capture-time end", async () => {
    await db.insert(chatMessages).values([
      { twitchMessageId: "match", broadcasterUserId: "broadcaster", twitchStreamId: "stream", chatterLogin: "chatter", receivedAt: firstSeen },
      { twitchMessageId: "end", broadcasterUserId: "broadcaster", twitchStreamId: "stream", chatterLogin: "chatter", receivedAt: latestSeen },
      { twitchMessageId: "other", broadcasterUserId: "broadcaster", twitchStreamId: "stream", chatterLogin: "another", receivedAt: firstSeen }
    ]);
    const query = new URLSearchParams({ chatter: "CHATTER", from: firstSeen.toISOString(), to: latestSeen.toISOString() });
    const response = await app.request(`/api/private/streams/stream/messages?${query}`);
    expect(response.status).toBe(200);
    expect((await response.json()).data.items.map((item: { messageId: string }) => item.messageId)).toEqual(["match"]);
  });

  it.each(["page=0", "page=100001", "from=invalid", "from=2026-09-05T11:00:00Z&to=2026-09-05T10:00:00Z"])("rejects invalid detail filters: %s", async (query) => {
    expect((await app.request(`/api/private/streams/stream/messages?${query}`)).status).toBe(400);
  });

  it("preserves private access and suppressed-stream protection on every new route", async () => {
    const publicApp = createApiApp({ db, config: { ...config, APP_MODE: "production" } });
    for (const kind of ["messages", "membership", "presence"]) {
      expect((await publicApp.request(`/api/private/streams/stream/${kind}`)).status).toBe(403);
      expect((await publicApp.request(`/api/private/streams/stream/${kind}`, { headers })).status).toBe(403);
    }
    await db.insert(subjectPrivacyStates).values({ twitchUserId: "broadcaster", publicProfileHidden: true });
    for (const kind of ["overview", "observations", "buckets", "events"]) {
      expect((await publicApp.request(`/api/streams/stream/${kind}`)).status).toBe(404);
      expect((await app.request(`/api/streams/missing/${kind}`)).status).toBe(404);
    }
    await db.update(appUsers).set({ isAdmin: true }).where(eq(appUsers.twitchUserId, "chatter"));
    expect((await publicApp.request("/api/streams/stream/overview", { headers })).status).toBe(200);
    expect((await publicApp.request("/api/private/streams/stream/messages", { headers })).status).toBe(200);
  });

  it("reviews a historical channel period with matching UTC boundaries for audience, airtime and chat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
    try {
      await db.insert(streamSessions).values({ twitchStreamId: "midnight", broadcasterUserId: "broadcaster",
        startedAt: new Date("2026-08-31T23:57:00Z"), endedAt: new Date("2026-09-01T00:06:00Z") });
      await db.insert(streamSnapshots).values([
        { twitchStreamId: "midnight", broadcasterUserId: "broadcaster", observedAt: new Date("2026-08-31T23:58:00Z"), viewerCount: 10, title: "Night stream", categoryId: "game", categoryName: "Game" },
        { twitchStreamId: "midnight", broadcasterUserId: "broadcaster", observedAt: new Date("2026-09-01T00:04:00Z"), viewerCount: 40 }
      ]);
      await db.insert(channelDailyStats).values([
        { broadcasterUserId: "broadcaster", day: "2026-09-07", messageCount: 25 },
        { broadcasterUserId: "broadcaster", day: "2026-09-08", messageCount: 999 }
      ]);
      const response = await app.request("/api/channels/channel/overview?days=7&end=2026-09-07");
      expect(response.status).toBe(200);
      const data = (await response.json()).data;
      expect([data.fromDay, data.toDay]).toEqual(["2026-09-01", "2026-09-07"]);
      expect(data.totals).toEqual({ streamCount: 1, liveSeconds: 540, messageCount: 25, viewerCountAvg: 20, viewerCountMax: 40 });
      expect(data.viewerSeconds).toBe(360);
      expect(data.categorySeconds).toBe(360);
      expect(data.daily.map((day: { day: string }) => day.day)).toEqual(["2026-09-01", "2026-09-05", "2026-09-07"]);
    } finally { vi.useRealTimers(); }
  });

  it("drills into streams active on a UTC day, including overnight streams but excluding boundary-only overlap", async () => {
    await db.insert(streamSessions).values([
      { twitchStreamId: "overnight", broadcasterUserId: "broadcaster", startedAt: new Date("2026-09-04T23:58:00Z"), endedAt: new Date("2026-09-05T00:04:00Z") },
      { twitchStreamId: "ends-at-midnight", broadcasterUserId: "broadcaster", startedAt: new Date("2026-09-04T23:00:00Z"), endedAt: new Date("2026-09-05T00:00:00Z") },
      { twitchStreamId: "starts-tomorrow", broadcasterUserId: "broadcaster", startedAt: new Date("2026-09-06T00:00:00Z") },
      { twitchStreamId: "another-channel", broadcasterUserId: "chatter", startedAt: firstSeen }
    ]);
    const response = await app.request("/api/channels/channel/sessions?day=2026-09-05");
    expect(response.status).toBe(200);
    expect((await response.json()).data.items.map((item: { twitchStreamId: string }) => item.twitchStreamId)).toEqual(["stream", "overnight"]);
  });

  it.each([
    "overview?days=0", "overview?days=91", "overview?days=7&days=90",
    "overview?end=2026-02-30", "overview?end=9999-01-01", "overview?end=0000-01-01",
    "sessions?day=2026-02-30", "sessions?day=9999-01-01", "sessions?day=2026-09-05&day=2026-09-06"
  ])("rejects invalid or ambiguous channel periods: %s", async (suffix) => {
    expect((await app.request(`/api/channels/channel/${suffix}`)).status).toBe(400);
  });

  it("supports 90 calendar days across a leap day and keeps the default period unchanged", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-10T12:00:00Z"));
    try {
      await db.insert(channelDailyStats).values([
        { broadcasterUserId: "broadcaster", day: "2024-02-29", messageCount: 20 },
        { broadcasterUserId: "broadcaster", day: "2024-03-02", messageCount: 999 }
      ]);
      const historical = (await (await app.request("/api/channels/channel/overview?days=90&end=2024-03-01")).json()).data;
      expect([historical.fromDay, historical.toDay]).toEqual(["2023-12-03", "2024-03-01"]);
      expect(historical.totals.messageCount).toBe(20);
      expect(historical.totals.viewerCountAvg).toBeNull();
      const current = (await (await app.request("/api/channels/channel/overview")).json()).data;
      expect([current.fromDay, current.toDay]).toEqual(["2026-08-12", "2026-09-10"]);
      expect(current.asOf).toBe("2026-09-10T12:00:00.000Z");
    } finally { vi.useRealTimers(); }
  });

  it("paginates only streams active on the selected day", async () => {
    await db.insert(streamSessions).values(Array.from({ length: 51 }, (_, index) => ({
      twitchStreamId: `day-${index.toString().padStart(2, "0")}`, broadcasterUserId: "broadcaster", startedAt: firstSeen
    })));
    await db.insert(streamSessions).values({ twitchStreamId: "outside-day", broadcasterUserId: "broadcaster", startedAt: new Date("2026-09-06T00:00:00Z") });
    const first = (await (await app.request("/api/channels/channel/sessions?day=2026-09-05")).json()).data;
    const second = (await (await app.request("/api/channels/channel/sessions?day=2026-09-05&page=2")).json()).data;
    expect(first.items).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(second.items.map((item: { twitchStreamId: string }) => item.twitchStreamId)).toEqual(["day-01", "day-00"]);
    expect(second.hasMore).toBe(false);
  });

  it("bounds channel snapshot reads and does not query raw chat or activity buckets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-06T12:00:00Z"));
    const querySpy = vi.spyOn(pool, "query");
    try {
      const response = await app.request("/api/channels/CHANNEL/overview");
      expect(response.status).toBe(200);
      const data = (await response.json()).data;
      expect(data.totals).toEqual({ streamCount: 1, liveSeconds: 180, messageCount: 0, viewerCountMax: null, viewerCountAvg: null });
      expect(data.daily).toEqual([{ day: "2026-09-05", streamCount: 1, liveSeconds: 180, messageCount: 0, viewerCountMax: null, viewerCountAvg: null }]);
      expect(data.topCategories).toEqual([]);
      expect(data.liveSession.twitchStreamId).toBe("stream");
      expect(data.recentSessions).toHaveLength(1);
      const queries = querySpy.mock.calls.map((call) => {
        const query: unknown = call[0];
        return typeof query === "string" ? query : query != null && typeof query === "object" && "text" in query ? String(query.text) : "";
      }).join("\n");
      expect(queries).toContain("channel_daily_stats");
      expect(queries).toContain('"stream_snapshots"."broadcaster_user_id" =');
      expect(queries).toContain('"stream_snapshots"."observed_at" >=');
      expect(queries).toContain('"stream_snapshots"."observed_at" <');
      expect(queries).not.toMatch(/stream_activity_buckets|chat_messages|chat_membership_events|chat_presence_|raw_irc_messages|raw_eventsub_events/);
    } finally {
      querySpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("counts category airtime across compacted snapshots and stops at an explicit category removal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-06T12:00:00Z"));
    try {
      await db.update(streamSessions).set({ endedAt: new Date("2026-09-05T10:15:00Z") }).where(eq(streamSessions.twitchStreamId, "stream"));
      await db.insert(streamSnapshots).values([
        { twitchStreamId: "stream", broadcasterUserId: "broadcaster", observedAt: firstSeen, viewerCount: 10, title: "Playing", categoryId: "game", categoryName: "Game" },
        { twitchStreamId: "stream", broadcasterUserId: "broadcaster", observedAt: latestSeen, viewerCount: 30 },
        { twitchStreamId: "stream", broadcasterUserId: "broadcaster", observedAt: new Date("2026-09-05T10:06:00Z"), viewerCount: 50, title: "Talking", categoryId: "chat", categoryName: "Just Chatting" },
        { twitchStreamId: "stream", broadcasterUserId: "broadcaster", observedAt: new Date("2026-09-05T10:09:00Z"), viewerCount: 70 },
        { twitchStreamId: "stream", broadcasterUserId: "broadcaster", observedAt: new Date("2026-09-05T10:12:00Z"), viewerCount: 90, title: "No category" }
      ]);
      const response = await app.request("/api/channels/channel/overview");
      expect(response.status).toBe(200);
      const data = (await response.json()).data;
      expect(data.categorySeconds).toBe(720);
      expect(data.topCategories).toEqual([
        { id: "chat", name: "Just Chatting", liveSeconds: 360, viewerCountAvg: 60 },
        { id: "game", name: "Game", liveSeconds: 360, viewerCountAvg: 20 }
      ]);
      expect(data.totals.viewerCountAvg).toBe(50);
    } finally { vi.useRealTimers(); }
  });

  it("recovers categories set before the period without carrying audience gaps or another session's category", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
    try {
      await db.update(streamSessions).set({ startedAt: new Date("2026-08-31T22:00:00Z"), endedAt: new Date("2026-09-01T00:09:00Z") }).where(eq(streamSessions.twitchStreamId, "stream"));
      await db.insert(streamSessions).values({ twitchStreamId: "uncategorized", broadcasterUserId: "broadcaster", startedAt: new Date("2026-09-01T01:00:00Z"), endedAt: new Date("2026-09-01T01:03:00Z") });
      await db.insert(streamSnapshots).values([
        { twitchStreamId: "stream", broadcasterUserId: "broadcaster", observedAt: new Date("2026-08-31T22:00:00Z"), viewerCount: 999, title: "Game night", categoryId: "game", categoryName: "Game" },
        ...[20, 40, 60].map((viewerCount, index) => ({ twitchStreamId: "stream", broadcasterUserId: "broadcaster", observedAt: new Date(`2026-09-01T00:0${index * 3}:00Z`), viewerCount })),
        { twitchStreamId: "uncategorized", broadcasterUserId: "broadcaster", observedAt: new Date("2026-09-01T01:00:00Z"), viewerCount: 20 }
      ]);
      const response = await app.request("/api/channels/channel/overview");
      expect(response.status).toBe(200);
      const data = (await response.json()).data;
      expect(data.fromDay).toBe("2026-09-01");
      expect(data.categorySeconds).toBe(540);
      expect(data.topCategories).toEqual([{ id: "game", name: "Game", liveSeconds: 540, viewerCountAvg: 40 }]);
      expect(data.viewerSeconds).toBe(720);
      expect(data.totals.viewerCountMax).toBe(60);
    } finally { vi.useRealTimers(); }
  });

  it("uses the same 30 UTC calendar days for channel chart and totals", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const dayAt = (offset: number) => new Date(Date.parse(today) + offset * 86_400_000).toISOString().slice(0, 10);
    await db.update(streamSessions).set({ startedAt: new Date(dayAt(-31)), endedAt: new Date(dayAt(-30)) }).where(eq(streamSessions.twitchStreamId, "stream"));
    await db.insert(streamSessions).values([
      { twitchStreamId: "first-day", broadcasterUserId: "broadcaster", startedAt: new Date(`${dayAt(-29)}T10:00:00Z`), endedAt: new Date(`${dayAt(-29)}T11:00:00Z`) },
      { twitchStreamId: "yesterday-one", broadcasterUserId: "broadcaster", startedAt: new Date(`${dayAt(-1)}T10:00:00Z`), endedAt: new Date(`${dayAt(-1)}T11:00:00Z`) },
      { twitchStreamId: "yesterday-two", broadcasterUserId: "broadcaster", startedAt: new Date(`${dayAt(-1)}T11:00:00Z`), endedAt: new Date(`${dayAt(-1)}T12:00:00Z`) },
      { twitchStreamId: "another-channel", broadcasterUserId: "chatter", startedAt: new Date(`${dayAt(-1)}T10:00:00Z`), endedAt: new Date(`${dayAt(-1)}T11:00:00Z`) }
    ]);
    await db.insert(streamSnapshots).values([
      ...["10:00", "10:30", "11:00"].map((time) => ({ twitchStreamId: "first-day", broadcasterUserId: "broadcaster", observedAt: new Date(`${dayAt(-29)}T${time}:00Z`), viewerCount: time === "11:00" ? 30 : 10, categoryId: "game", categoryName: "Game" })),
      ...["10:00", "10:30", "11:00"].map((time) => ({ twitchStreamId: "yesterday-one", broadcasterUserId: "broadcaster", observedAt: new Date(`${dayAt(-1)}T${time}:00Z`), viewerCount: time === "11:00" ? 50 : 20, categoryId: "game", categoryName: "Game" })),
      ...["11:00", "11:30"].map((time) => ({ twitchStreamId: "yesterday-two", broadcasterUserId: "broadcaster", observedAt: new Date(`${dayAt(-1)}T${time}:00Z`), viewerCount: 20, categoryId: "chat", categoryName: "Just Chatting" })),
      { twitchStreamId: "another-channel", broadcasterUserId: "chatter", observedAt: new Date(`${dayAt(-1)}T10:00:00Z`), viewerCount: 99999, categoryId: "other", categoryName: "Other" }
    ]);
    await db.insert(channelDailyStats).values([
      { broadcasterUserId: "broadcaster", day: dayAt(-30), streamCount: 100, liveSeconds: 99999, viewerCountMax: 99999, viewerCountAvg: 99999, messageCount: 99999 },
      { broadcasterUserId: "broadcaster", day: dayAt(-29), streamCount: 1, liveSeconds: 3600, viewerCountMax: 30, viewerCountAvg: 10, messageCount: 50 },
      { broadcasterUserId: "broadcaster", day: dayAt(-1), streamCount: 0, messageCount: 5 },
      { broadcasterUserId: "broadcaster", day: today, streamCount: 2, liveSeconds: 7200, viewerCountMax: 50, viewerCountAvg: 20, messageCount: 100 },
      { broadcasterUserId: "broadcaster", day: dayAt(1), streamCount: 100, liveSeconds: 99999, viewerCountMax: 99999, viewerCountAvg: 99999, messageCount: 99999 },
      { broadcasterUserId: "chatter", day: today, streamCount: 100, messageCount: 99999 }
    ]);
    const response = await app.request("/api/channels/channel/overview");
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.fromDay).toBe(dayAt(-29));
    expect(data.toDay).toBe(today);
    expect(data.daily.map((day: { day: string }) => day.day)).toEqual([dayAt(-29), dayAt(-1), today]);
    expect(data.daily[2].viewerCountAvg).toBeNull();
    expect(data.totals).toEqual({ streamCount: 3, liveSeconds: 10800, messageCount: 155, viewerCountMax: 50, viewerCountAvg: 17 });
    expect(data.topCategories).toEqual([
      { id: "game", name: "Game", liveSeconds: 7200, viewerCountAvg: 15 },
      { id: "chat", name: "Just Chatting", liveSeconds: 3600, viewerCountAvg: 20 }
    ]);
  });

  it("bounds the recent channel preview and finds a live session outside it", async () => {
    await db.insert(streamSessions).values(Array.from({ length: 8 }, (_, index) => ({
      twitchStreamId: `recent-${index}`, broadcasterUserId: "broadcaster",
      startedAt: new Date(firstSeen.getTime() + (index + 1) * 60_000), endedAt: new Date(firstSeen.getTime() + (index + 2) * 60_000)
    })));
    const response = await app.request("/api/channels/channel/overview");
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.recentSessions).toHaveLength(6);
    expect(data.recentSessions[0].twitchStreamId).toBe("recent-7");
    expect(data.liveSession.twitchStreamId).toBe("stream");
    await db.update(streamSessions).set({ endedAt: latestSeen }).where(eq(streamSessions.twitchStreamId, "stream"));
    const ended = await app.request("/api/channels/channel/overview");
    expect((await ended.json()).data.liveSession).toBeNull();
  });

  it.each(["sessions", "daily", "observations", "buckets"])("paginates channel %s without including another channel", async (kind) => {
    await db.insert(streamSessions).values({ twitchStreamId: "other-channel-stream", broadcasterUserId: "chatter", startedAt: firstSeen });
    switch (kind) {
      case "sessions": await db.insert(streamSessions).values(Array.from({ length: 50 }, (_, index) => ({
        twitchStreamId: `session-${index}`, broadcasterUserId: "broadcaster", startedAt: firstSeen
      }))); break;
      case "daily": await db.insert(channelDailyStats).values([
        ...Array.from({ length: 51 }, (_, index) => ({ broadcasterUserId: "broadcaster", day: new Date(firstSeen.getTime() - index * 86_400_000).toISOString().slice(0, 10) })),
        { broadcasterUserId: "chatter", day: firstSeen.toISOString().slice(0, 10), messageCount: 99999 }
      ]); break;
      case "observations": await db.insert(streamSnapshots).values([
        ...Array.from({ length: 51 }, () => ({ broadcasterUserId: "broadcaster", twitchStreamId: "stream", observedAt: firstSeen })),
        { broadcasterUserId: "chatter", twitchStreamId: "other-channel-stream", observedAt: latestSeen }
      ]); break;
      case "buckets": await db.insert(streamActivityBuckets).values([
        ...Array.from({ length: 51 }, (_, index) => ({ twitchStreamId: "stream", bucketStart: new Date(firstSeen.getTime() + index * 60_000), bucketMinutes: 1 })),
        { twitchStreamId: "other-channel-stream", bucketStart: latestSeen, bucketMinutes: 1 }
      ]); break;
    }
    const first = await app.request(`/api/channels/channel/${kind}`);
    const second = await app.request(`/api/channels/channel/${kind}?page=2`);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstPage = (await first.json()).data;
    const secondPage = (await second.json()).data;
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);
    expect(firstPage.items).not.toContainEqual(secondPage.items[0]);
    expect(JSON.stringify([firstPage, secondPage])).not.toMatch(/other-channel-stream|99999/);
    expect((await app.request(`/api/channels/channel/${kind}?page=0`)).status).toBe(400);
  });

  it("keeps fallback metadata attached to the correct channel session", async () => {
    await db.insert(streamSessions).values({ twitchStreamId: "other-session", broadcasterUserId: "broadcaster", startedAt: latestSeen });
    await db.insert(streamSnapshots).values([
      { broadcasterUserId: "broadcaster", twitchStreamId: "stream", observedAt: firstSeen, title: "Original title", categoryName: "Original category" },
      { broadcasterUserId: "broadcaster", twitchStreamId: "stream", observedAt: latestSeen, viewerCount: 5 },
      { broadcasterUserId: "broadcaster", twitchStreamId: "other-session", observedAt: latestSeen, title: "Other title", categoryName: "Other category" }
    ]);
    const response = await app.request("/api/channels/channel/observations");
    expect(response.status).toBe(200);
    expect((await response.json()).data.items).toContainEqual(expect.objectContaining({ twitchStreamId: "stream", viewerCount: 5, title: "Original title", categoryName: "Original category" }));
  });

  it.each(["publicProfileHidden", "trackingOptedOut"] as const)("protects all channel detail routes when %s", async (flag) => {
    const publicApp = createApiApp({ db, config: { ...config, APP_MODE: "production" } });
    await db.insert(subjectPrivacyStates).values({ twitchUserId: "broadcaster", [flag]: true });
    for (const kind of ["overview", "sessions", "daily", "observations", "buckets"]) {
      expect((await publicApp.request(`/api/channels/channel/${kind}`)).status).toBe(404);
      expect((await publicApp.request(`/api/channels/channel/${kind}`, { headers })).status).toBe(404);
      expect((await app.request(`/api/channels/missing/${kind}`)).status).toBe(404);
    }
    await db.update(appUsers).set({ isAdmin: true }).where(eq(appUsers.twitchUserId, "chatter"));
    for (const kind of ["overview", "sessions", "daily", "observations", "buckets"]) {
      expect((await publicApp.request(`/api/channels/channel/${kind}`, { headers })).status).toBe(200);
    }
  });

  describe.each(["/api/me/data", "/api/private/chatters/chatter"])("%s", (path) => {
    it("serializes first and last message timestamps", async () => {
      await db.insert(chatMessages).values([
        { twitchMessageId: "later", broadcasterUserId: "broadcaster", chatterUserId: "chatter", receivedAt: latestSeen },
        { twitchMessageId: "earlier", broadcasterUserId: "broadcaster", chatterUserId: "chatter", receivedAt: firstSeen }
      ]);

      const response = await app.request(path, { headers });
      expect(response.status).toBe(200);
      expect((await response.json()).data.summary).toEqual({
        messageCount: 2, channelCount: 1,
        firstMessageAt: firstSeen.toISOString(), lastMessageAt: latestSeen.toISOString()
      });
    });

    it("preserves null timestamps when there are no messages", async () => {
      const response = await app.request(path, { headers });
      expect(response.status).toBe(200);
      expect((await response.json()).data.summary).toEqual({
        messageCount: 0, channelCount: 0, firstMessageAt: null, lastMessageAt: null
      });
    });
  });
});
