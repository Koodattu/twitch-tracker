import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret, hashSessionToken, loadConfig } from "@twitch-tracker/config";
import { appUsers, chatMessages, createDb, oauthAccounts, sessions, streamSessions, streamSnapshots, subjectPrivacyStates, twitchUsers } from "@twitch-tracker/db";
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
