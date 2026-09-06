import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret, hashSessionToken, loadConfig } from "@twitch-tracker/config";
import { appUsers, claimCommunityBuild, createDb, oauthAccounts, publishCommunityMap, sessions, twitchUsers } from "@twitch-tracker/db";
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
      nodes: [{ id: "channel", chatters: 20, community: "group", x: 300, y: 400 }, { id: "admin", chatters: 10, community: "group", x: 350, y: 420 }],
      edges: [{ source: "admin", target: "channel", shared: 5, score: 5 / Math.sqrt(200) }]
    }, { firstObservedAt: null, lastObservedAt: null, messages: 60, missingSession: 0, unknownSource: 0, relayedMessages: 0, qualifyingMemberships: 30 });
  };

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
    expect(body.data.graph.nodes[0]).toMatchObject({ id: "channel", login: "channel", chatters: 20 });
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
