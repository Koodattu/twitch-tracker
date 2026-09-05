import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret, hashSessionToken, loadConfig } from "@twitch-tracker/config";
import { appUsers, channelEvents, chatMembershipEvents, chatMessages, chatPresenceSnapshots, createDb, oauthAccounts, raids, rawEventsubEvents, sessions, streamActivityBuckets, streamSessions, streamSnapshots, subjectPrivacyStates, twitchUsers } from "@twitch-tracker/db";
import { eq } from "drizzle-orm";
import { createApiApp } from "./routes.js";

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
    expect(points[0].messagesPerMinute).toBeNull();
    expect(points[1]).toMatchObject({ viewers: null, viewerPeak: null, messagesPerMinute: null, activeChatters: null, interrupted: true });
    expect(points[3]).toMatchObject({ viewers: 20, messagesPerMinute: 3, activeChatters: 2, interrupted: true });
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
