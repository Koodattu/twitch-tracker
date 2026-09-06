import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimCommunityBuild, communityWindow, createDb, failCommunityBuild, invalidateCommunityMaps,
  publishCommunityMap, renewCommunityLease, requestCommunityBuild } from "@twitch-tracker/db";
import { loadConfig } from "@twitch-tracker/config";
import { DisabledHelixAdapter } from "@twitch-tracker/twitch";
import type { CommunityCoverage } from "@twitch-tracker/shared";
import { readCommunityInput } from "./community-input.js";
import { runCommunityBuild } from "./loops/community-map.js";

const url = process.env.TEST_DATABASE_URL;
if (url != null && !new URL(url).pathname.toLowerCase().includes("test")) throw new Error("TEST_DATABASE_URL must name a dedicated test database.");
const database = url == null ? null : createDb(url);
const coverage: CommunityCoverage = { messages: 0, firstObservedAt: null, lastObservedAt: null, missingSession: 0, unknownSource: 0, relayedMessages: 0, qualifyingMemberships: 0 };

describe("Community schedule", () => {
  it("uses the latest due UTC window across midnight, restart, and the nightly boundary", () => {
    expect(communityWindow(new Date("2026-09-06T02:59:00Z")).windowEnd.toISOString()).toBe("2026-09-05T00:00:00.000Z");
    expect(communityWindow(new Date("2026-09-06T03:00:00Z")).windowEnd.toISOString()).toBe("2026-09-06T00:00:00.000Z");
    expect(communityWindow(new Date("2026-09-06T02:00:00Z"), true).windowEnd.toISOString()).toBe("2026-09-06T00:00:00.000Z");
  });
});

describe.skipIf(database == null)("Community builds with PostgreSQL", () => {
  if (database == null) return;
  const { db, pool } = database;
  beforeEach(async () => {
    await pool.query("truncate table community_map_state, community_map_snapshots, job_locks, twitch_users cascade");
    await pool.query("insert into community_map_state (id) values ('current')");
  });
  afterAll(async () => { await pool.end(); });

  it("allows only one lease, coalesces requests, and recovers an expired worker", async () => {
    await Promise.all([requestCommunityBuild(db), requestCommunityBuild(db)]);
    const claims = await Promise.all([claimCommunityBuild(db), claimCommunityBuild(db)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const first = claims.find((claim) => claim != null)!;
    expect(first.requestVersion).toBe(1);
    expect(await renewCommunityLease(db, first)).toBe(true);
    await pool.query("update job_locks set expires_at = now() - interval '1 second'");
    const replacement = (await claimCommunityBuild(db))!;
    expect(replacement.owner).not.toBe(first.owner);
    expect(await renewCommunityLease(db, first)).toBe(false);
    expect(await publishCommunityMap(db, first, { nodes: [], edges: [] }, coverage)).toBe(false);
    expect(await publishCommunityMap(db, replacement, { nodes: [], edges: [] }, coverage)).toBe(true);
    expect(await claimCommunityBuild(db)).toBeNull();
  });

  it("keeps the previous snapshot after failure, retries on demand, and invalidates in-flight work on privacy changes", async () => {
    const first = (await claimCommunityBuild(db))!;
    await publishCommunityMap(db, first, { nodes: [], edges: [] }, coverage);
    await requestCommunityBuild(db);
    const failed = (await claimCommunityBuild(db))!;
    await failCommunityBuild(db, failed);
    expect((await pool.query("select snapshot_id, status from community_map_state")).rows[0]).toMatchObject({ status: "failed", snapshot_id: expect.any(String) });
    expect(await claimCommunityBuild(db)).toBeNull();
    await requestCommunityBuild(db);
    const stale = (await claimCommunityBuild(db))!;
    await db.transaction(async (tx) => { await invalidateCommunityMaps(tx); });
    expect(await publishCommunityMap(db, stale, { nodes: [], edges: [] }, coverage)).toBe(false);
    expect((await pool.query("select graph, valid from community_map_snapshots")).rows.every((row) => row.graph == null && !row.valid)).toBe(true);
    await failCommunityBuild(db, stale);
    expect(await claimCommunityBuild(db)).not.toBeNull();
  });

  it("filters input and builds an actual snapshot without chatter identities", async () => {
    await pool.query(`insert into twitch_users (twitch_user_id, login)
      select id, id from unnest(array['100','200','300','400','500','600','700','800','900','bot','hidden']) as id
      union all select 'chatter-' || n, 'chatter-' || n from generate_series(1,10) n`);
    await pool.query(`insert into stream_sessions (twitch_stream_id, broadcaster_user_id, started_at, is_finnish_eligible, finnish_match_reason)
      select id, id, date_trunc('day', now()) - interval '2 days', id <> '400',
        case id when '100' then 'language'::finnish_stream_match_reason when '200' then 'tag'::finnish_stream_match_reason else 'manual'::finnish_stream_match_reason end
      from unnest(array['100','200','300','400','500','600','700','800','900']) as id`);
    await pool.query("insert into bot_accounts (twitch_user_id, login) values ('bot','bot'); insert into subject_privacy_states (twitch_user_id, public_profile_hidden) values ('hidden',true),('800',true)");
    await pool.query(`insert into chat_messages (twitch_message_id, broadcaster_user_id, twitch_stream_id, chatter_user_id, received_at, shared_chat_source_channel_id)
      select channel || '-' || person || '-' || message, channel, case when channel = '500' then null else channel end, person,
        date_trunc('day', now()) - interval '1 day', case when channel = '300' then '100' when channel = '600' then null else channel end
      from unnest(array['100','200','300','400','500','600','700','800','900']) as channel
      cross join unnest(array['bot','hidden','chatter-1','chatter-2','chatter-3','chatter-4','chatter-5','chatter-6','chatter-7','chatter-8','chatter-9','chatter-10']) as person
      cross join generate_series(1,3) as message where channel <> '700' or message < 3`);
    await pool.query(`insert into raw_irc_messages (id, raw_line) values ('00000000-0000-0000-0000-000000000001','@id=ordinary;room-id=900 :chatter PRIVMSG #channel :Hello');
      update chat_messages set shared_chat_source_channel_id = null, raw_irc_message_id = '00000000-0000-0000-0000-000000000001' where broadcaster_user_id = '900'`);
    await requestCommunityBuild(db);
    const claim = (await claimCommunityBuild(db))!;
    const input = await readCommunityInput(db, claim);
    expect(input.memberships).toHaveLength(30);
    expect(new Set(input.memberships.map((row) => row.channelId))).toEqual(new Set(["100", "200", "900"]));
    expect(input.memberships.every((row) => row.chatterId.startsWith("chatter-"))).toBe(true);
    expect(input.coverage).toMatchObject({ missingSession: 36, unknownSource: 30, relayedMessages: 30 });
    await pool.query("delete from job_locks");
    const result = await runCommunityBuild({ config: loadConfig({ DATABASE_URL: url, SESSION_SECRET: "s".repeat(48) }), db,
      rest: new DisabledHelixAdapter(), workerName: "test", abortSignal: new AbortController().signal });
    expect(result).toMatchObject({ channels: 3, edges: 3 });
    const snapshot = (await pool.query("select graph from community_map_snapshots")).rows[0].graph;
    expect(snapshot.nodes.every((node: { chatters: number }) => node.chatters === 10)).toBe(true);
    expect(snapshot.edges.every((edge: { shared: number; score: number }) => edge.shared === 10 && edge.score === 1)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("chatter-");
  });
});
