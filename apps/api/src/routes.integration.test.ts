import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret, hashSessionToken, loadConfig } from "@twitch-tracker/config";
import { appUsers, chatMessages, createDb, oauthAccounts, sessions, streamSessions, streamSnapshots, twitchUsers } from "@twitch-tracker/db";
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
