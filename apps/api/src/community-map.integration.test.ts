import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret, hashSessionToken, loadConfig } from "@twitch-tracker/config";
import { appUsers, chatMessages, chatMembershipEvents, chatPresenceObservations, chatPresenceSnapshots, claimCommunityBuild, createDb, oauthAccounts, publishCommunityMap, sessions, streamSessions, twitchUsers } from "@twitch-tracker/db";
import { createApiApp } from "./routes.js";

const url = process.env.TEST_DATABASE_URL;
if (url != null && !new URL(url).pathname.toLowerCase().includes("test")) throw new Error("TEST_DATABASE_URL must name a dedicated test database.");
const database = url == null ? null : createDb(url);

describe.skipIf(database == null)("Community API with PostgreSQL", () => {
  if (database == null) return;
  const { db, pool } = database;
  const config = loadConfig({ DATABASE_URL: url, SESSION_SECRET: "s".repeat(48) });
  const app = createApiApp({ config, db });
  const headers = { Cookie: "twitch_tracker_session=map-test", Origin: "http://localhost:3000", "Content-Type": "application/json" };
  beforeEach(async () => {
    await pool.query("truncate table community_map_state, community_map_snapshots, job_locks, twitch_users cascade");
    await pool.query("insert into community_map_state (id) values ('current')");
    await db.insert(twitchUsers).values([{ twitchUserId: "admin", login: "admin" }, { twitchUserId: "channel", login: "channel" }]);
    const [user] = await db.insert(appUsers).values({ twitchUserId: "admin", isAdmin: true }).returning();
    await db.insert(sessions).values({ sessionIdHash: hashSessionToken("map-test", config.SESSION_SECRET), appUserId: user!.id, expiresAt: new Date(Date.now() + 3_600_000) });
    await db.insert(oauthAccounts).values({ appUserId: user!.id, providerUserId: "admin", provider: "twitch",
      encryptedAccessToken: encryptSecret("synthetic-test-token", config.SESSION_SECRET), lastValidatedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) });
  });
  afterAll(async () => { await pool.end(); });

  const publish = async () => {
    const claim = (await claimCommunityBuild(db))!;
    await publishCommunityMap(db, claim, {
      nodes: [{ id: "channel", chatters: 20, participants: 30, community: "group", x: 300, y: 400 }, { id: "admin", chatters: 10, participants: 20, community: "group", x: 350, y: 420 }],
      edges: [{ source: "admin", target: "channel", shared: 5, score: 5 / Math.sqrt(200) }]
    }, { firstObservedAt: null, lastObservedAt: null, messages: 60, missingSession: 0, unknownSource: 0, relayedMessages: 0, qualifyingMemberships: 50,
      presence: { events: 40, unresolvedEvents: 0, recoveredEvents: 0, observedChannels: 2, snapshotChannels: 0, qualifyingMemberships: 20, presenceOnlyMemberships: 20 } });
    return claim;
  };

  it("highlights an account's recorded messages and repeated presence in the current map for admins only", async () => {
    const claim = await publish();
    await db.insert(twitchUsers).values({ twitchUserId: "person", login: "testichat", displayName: "TestiChat" });
    await db.insert(streamSessions).values(["channel", "admin"].map(id => ({
      twitchStreamId: `stream-${id}`, broadcasterUserId: id, startedAt: claim.windowStart, endedAt: claim.windowEnd, isFinnishEligible: true
    })));
    const day = new Date(claim.windowStart.getTime() + 86400_000);
    await db.insert(chatMessages).values([0, 1, 2].map(i => ({
      twitchMessageId: `lookup-message-${i}`, broadcasterUserId: "channel", twitchStreamId: "stream-channel",
      chatterUserId: "person", sharedChatSourceChannelId: "channel", receivedAt: new Date(day.getTime() + i * 60_000), rawText: "Must not be returned"
    })));
    await db.insert(chatMembershipEvents).values([0, 1].map(i => ({
      broadcasterUserId: "admin", twitchStreamId: "stream-admin", chatterUserId: "person", eventType: "join" as const,
      receivedAt: new Date(day.getTime() + i * 86400_000)
    })));
    const response = await app.request("/api/internal/communities/chatters/TestiChat", { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.data).toMatchObject({ login: "testichat", windowStart: claim.windowStart.toISOString(), windowEnd: claim.windowEnd.toISOString() });
    expect(body.data.channels).toEqual([
      expect.objectContaining({ channelId: "channel", messages: 3, messageDays: 1, presenceDays: 0 }),
      expect.objectContaining({ channelId: "admin", messages: 0, messageDays: 0, presenceDays: 2 })
    ]);
    expect(JSON.stringify(body)).not.toContain("Must not be returned");
    expect((await app.request("/api/internal/communities/chatters/testichat")).status).toBe(403);
    await pool.query("update app_users set is_admin = false");
    expect((await app.request("/api/internal/communities/chatters/testichat", { headers })).status).toBe(403);
  });

  it("excludes out-of-window, relayed, unknown-source and non-Finnish messages, and requires repeated stable presence", async () => {
    const claim = await publish();
    await db.insert(twitchUsers).values({ twitchUserId: "person", login: "testichat" });
    await db.insert(streamSessions).values([
      { twitchStreamId: "fi", broadcasterUserId: "channel", startedAt: claim.windowStart, endedAt: claim.windowEnd, isFinnishEligible: true },
      { twitchStreamId: "other", broadcasterUserId: "channel", startedAt: claim.windowStart, endedAt: claim.windowEnd, isFinnishEligible: false },
      { twitchStreamId: "presence", broadcasterUserId: "admin", startedAt: claim.windowStart, endedAt: claim.windowEnd, isFinnishEligible: true }
    ]);
    const day = new Date(claim.windowStart.getTime() + 47 * 3600_000);
    const message = { broadcasterUserId: "channel", twitchStreamId: "fi", chatterUserId: "person", sharedChatSourceChannelId: "channel", receivedAt: day, rawText: "Synthetic" };
    await db.insert(chatMessages).values([
      { ...message, twitchMessageId: "one" }, { ...message, twitchMessageId: "two" },
      { ...message, twitchMessageId: "before", receivedAt: new Date(claim.windowStart.getTime() - 1) },
      { ...message, twitchMessageId: "end", receivedAt: claim.windowEnd },
      { ...message, twitchMessageId: "relay", sharedChatSourceChannelId: "admin" },
      { ...message, twitchMessageId: "unknown", sharedChatSourceChannelId: null },
      { ...message, twitchMessageId: "non-fi", twitchStreamId: "other" },
      { ...message, twitchMessageId: "no-stream", twitchStreamId: null }
    ]);
    const presence = { broadcasterUserId: "admin", twitchStreamId: "presence", chatterUserId: "person", eventType: "join" as const };
    await db.insert(chatMembershipEvents).values([
      { ...presence, receivedAt: day }, { ...presence, receivedAt: new Date(day.getTime() + 2 * 3600_000) },
      { ...presence, chatterUserId: null, chatterLogin: "testichat", receivedAt: new Date(day.getTime() + 24 * 3600_000) }
    ]);
    const lookup = async () => (await (await app.request("/api/internal/communities/chatters/testichat", { headers })).json()).data.channels;
    expect(await lookup()).toEqual([]);
    await db.insert(chatMessages).values({ ...message, twitchMessageId: "three", receivedAt: claim.windowStart });
    await db.insert(chatMembershipEvents).values({ ...presence, receivedAt: new Date(day.getTime() + 7 * 3600_000) });
    expect(await lookup()).toEqual([
      expect.objectContaining({ channelId: "channel", messages: 3, messageDays: 2, presenceDays: 0 }),
      expect.objectContaining({ channelId: "admin", messages: 0, presenceDays: 2 })
    ]);
    await pool.query("insert into subject_privacy_states (twitch_user_id, public_profile_hidden) values ('channel', true)");
    expect(await lookup()).toEqual([expect.objectContaining({ channelId: "admin" })]);
  });

  it("combines valid snapshot and membership presence by UTC day, excluding failed or mismatched snapshots", async () => {
    const claim = await publish();
    await db.insert(twitchUsers).values({ twitchUserId: "person", login: "testichat" });
    await db.insert(streamSessions).values({ twitchStreamId: "fi", broadcasterUserId: "channel", startedAt: claim.windowStart, endedAt: claim.windowEnd, isFinnishEligible: true });
    const day = new Date(claim.windowStart.getTime() + 86400_000);
    await db.insert(chatMembershipEvents).values({ broadcasterUserId: "channel", twitchStreamId: "fi", chatterUserId: "person", eventType: "join", receivedAt: day });
    for (const [index, requestStatus] of ["succeeded", "failed", "truncated"].entries()) {
      const observedAt = new Date(day.getTime() + index * 86400_000);
      const [snapshot] = await db.insert(chatPresenceSnapshots).values({ broadcasterUserId: "channel", twitchStreamId: "fi", source: "helix.get_chatters", requestStatus, sampledAt: observedAt }).returning();
      await db.insert(chatPresenceObservations).values({ snapshotId: snapshot!.id, broadcasterUserId: "channel", twitchStreamId: "fi", chatterUserId: "person", observedAt, source: "helix.get_chatters", dedupeKey: `lookup-${index}` });
    }
    const response = await app.request("/api/internal/communities/chatters/testichat", { headers });
    expect((await response.json()).data.channels).toEqual([expect.objectContaining({ channelId: "channel", presenceDays: 2 })]);
    await pool.query("update chat_presence_snapshots set broadcaster_user_id = 'admin' where request_status = 'truncated'");
    expect((await (await app.request("/api/internal/communities/chatters/testichat", { headers })).json()).data.channels).toEqual([]);
  });

  it("rejects unavailable, stale, invalid and suppressed lookups without revealing hidden identities", async () => {
    const lookup = (login = "testichat", query = "") => app.request(`/api/internal/communities/chatters/${login}${query}`, { headers });
    expect((await lookup()).status).toBe(503);
    await publish();
    expect((await lookup()).status).toBe(404);
    expect((await lookup("bad-name")).status).toBe(400);
    expect((await lookup("testichat", "?map=invalid")).status).toBe(400);
    expect((await lookup("testichat", "?map=2000-01-01T00:00:00.000Z")).status).toBe(409);
    await db.insert(twitchUsers).values({ twitchUserId: "person", login: "testichat" });
    expect((await lookup()).status).toBe(200);
    for (const flag of ["public_profile_hidden", "tracking_opted_out", "data_deleted_at"]) {
      await pool.query(`insert into subject_privacy_states (twitch_user_id, ${flag}) values ('person', ${flag === "data_deleted_at" ? "now()" : "true"})`);
      expect((await lookup()).status).toBe(404);
      await pool.query("delete from subject_privacy_states where twitch_user_id = 'person'");
    }
    await pool.query("insert into bot_accounts (twitch_user_id, login) values ('person', 'testichat')");
    expect((await lookup()).status).toBe(404);
  });

  it("excludes widespread presence even outside the displayed map while retaining original messages", async () => {
    const claim = await publish();
    const ids = ["channel", ...Array.from({ length: 50 }, (_, index) => `outside-${index}`)];
    await db.insert(twitchUsers).values([{ twitchUserId: "person", login: "testichat" }, ...ids.slice(1).map(id => ({ twitchUserId: id, login: id }))]);
    await db.insert(streamSessions).values(ids.map(id => ({ twitchStreamId: `stream-${id}`, broadcasterUserId: id,
      startedAt: claim.windowStart, endedAt: claim.windowEnd, isFinnishEligible: true })));
    await db.insert(chatMembershipEvents).values(ids.flatMap(id => [1, 2].map(day => ({
      broadcasterUserId: id, twitchStreamId: `stream-${id}`, chatterUserId: "person", eventType: "join" as const,
      receivedAt: new Date(claim.windowStart.getTime() + day * 86400_000)
    }))));
    const lookup = async () => (await (await app.request("/api/internal/communities/chatters/testichat", { headers })).json()).data.channels;
    expect(await lookup()).toEqual([]);
    await db.insert(chatMessages).values([0, 1, 2].map(index => ({ twitchMessageId: `original-${index}`,
      broadcasterUserId: "channel", twitchStreamId: "stream-channel", chatterUserId: "person", sharedChatSourceChannelId: "channel",
      receivedAt: new Date(claim.windowStart.getTime() + 86400_000), rawText: "Synthetic" })));
    expect(await lookup()).toEqual([expect.objectContaining({ channelId: "channel", messages: 3, presenceDays: 0 })]);
    await pool.query("delete from chat_membership_events where broadcaster_user_id = 'outside-49'");
    expect(await lookup()).toEqual([expect.objectContaining({ channelId: "channel", messages: 3, presenceDays: 2 })]);
  });

  it("requires an admin session and same-origin request to queue a build", async () => {
    expect((await app.request("/api/internal/communities/build", { method: "POST" })).status).toBe(403);
    expect((await app.request("/api/internal/communities/build", { method: "POST", headers: { ...headers, Origin: "https://elsewhere.example" } })).status).toBe(403);
    const response = await app.request("/api/internal/communities/build", { method: "POST", headers });
    expect(response.status).toBe(202);
    expect((await response.json()).data.status).toBe("queued");
    await pool.query("update app_users set is_admin = false");
    expect((await app.request("/api/internal/communities/build", { method: "POST", headers })).status).toBe(403);
  });

  it("serves saved aggregate data without caching and filters hidden channels and their edges", async () => {
    const empty = await app.request("/api/communities");
    expect((await empty.json()).data).toBeNull();
    await publish();
    await pool.query("insert into subject_privacy_states (twitch_user_id, public_profile_hidden) values ('admin', true)");
    const response = await app.request("/api/communities");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.data.graph.nodes).toHaveLength(1);
    expect(body.data.graph.nodes[0]).toMatchObject({ id: "channel", login: "channel", chatters: 20, participants: 30 });
    expect(body.data.coverage.presence.presenceOnlyMemberships).toBe(20);
    expect(body.data.graph.edges).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("admin");
  });

  it.each(["public_profile_opt_out", "tracking_opt_out", "data_deletion"])("invalidates all maps atomically when completing %s", async (requestType) => {
    await publish();
    const response = await app.request("/api/me/privacy/requests", { method: "POST", headers, body: JSON.stringify({ requestType }) });
    if (requestType === "data_deletion") {
      expect(response.status).toBe(202);
      const requestId = (await response.json()).data.request.id;
      const completed = await app.request(`/api/internal/privacy-requests/${requestId}/complete`, { method: "POST", headers });
      expect(completed.status).toBe(200);
    } else {
      expect(response.status).toBe(201);
    }
    const result = await app.request("/api/communities");
    expect((await result.json()).data).toBeNull();
    const snapshot = (await pool.query("select valid, graph, coverage from community_map_snapshots")).rows[0];
    expect(snapshot).toEqual({ valid: false, graph: null, coverage: null });
  });
});
