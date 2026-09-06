import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimCommunityBuild, createDb, requestCommunityBuild } from "@twitch-tracker/db";
import { readCommunityInput } from "./community-input.js";
import { buildCommunityGraph } from "./community-graph.js";
import { runCommunityBuild } from "./loops/community-map.js";
import { loadConfig } from "@twitch-tracker/config";
import { DisabledHelixAdapter } from "@twitch-tracker/twitch";

const url = process.env.TEST_DATABASE_URL;
if (url != null && !new URL(url).pathname.toLowerCase().includes("test")) throw new Error("TEST_DATABASE_URL must name a dedicated test database.");
const database = url == null ? null : createDb(url);

describe.skipIf(database == null)("Community presence with PostgreSQL", () => {
  if (database == null) return;
  const { db, pool } = database;
  beforeEach(async () => {
    await pool.query("truncate table community_map_state, community_map_snapshots, job_locks, twitch_users cascade");
    await pool.query("insert into community_map_state (id) values ('current')");
    await pool.query(`insert into twitch_users (twitch_user_id, login)
      select id, id from unnest(array['a','b','evidence','foreign','closed','hidden','bot','ambiguous','renamed','recycled','other']) id
      union all select 'person-' || n, 'person-' || n from generate_series(1,10) n;
      insert into stream_sessions (twitch_stream_id, broadcaster_user_id, started_at, ended_at, is_finnish_eligible)
      select id, id, date_trunc('day', now()) - interval '10 days',
        case when id = 'closed' then date_trunc('day', now()) - interval '5 days' else null end, id <> 'foreign'
      from unnest(array['a','b','evidence','foreign','closed']) id;
      insert into subject_privacy_states (twitch_user_id, public_profile_hidden) values ('hidden',true);
      insert into bot_accounts (twitch_user_id, login) values ('bot','bot')`);
  });
  afterAll(async () => { await pool.end(); });
  const read = async () => {
    await requestCommunityBuild(db);
    return readCommunityInput(db, (await claimCommunityBuild(db))!);
  };

  it("adds repeated native presence, deduplicates messages, and excludes private, bot, offline and non-Finnish activity", async () => {
    await pool.query(`insert into chat_membership_events (broadcaster_user_id, twitch_stream_id, chatter_user_id, event_type, received_at)
      select channel, channel, person, 'join', date_trunc('day', now()) - make_interval(days => day)
      from unnest(array['a','b','foreign','closed']) channel
      cross join (select 'person-' || n as person from generate_series(1,10) n union all select 'hidden' union all select 'bot') people
      cross join generate_series(1,2) day cross join generate_series(1,3) duplicate;
      insert into chat_messages (twitch_message_id, broadcaster_user_id, twitch_stream_id, chatter_user_id, received_at, shared_chat_source_channel_id)
      select 'message-' || n, 'a', 'a', 'person-1', date_trunc('day', now()) - interval '1 day', 'a' from generate_series(1,3) n`);
    const input = await read();
    expect(input.memberships).toHaveLength(20);
    expect(input.memberships.find((m) => m.chatterId === "person-1" && m.channelId === "a")!.weight).toBe(1);
    expect(input.memberships.filter((m) => m.weight === 0.25)).toHaveLength(19);
    const graph = buildCommunityGraph({ memberships: input.memberships, previous: null }).graph;
    expect(graph.nodes.map((node) => node.participants)).toEqual([10,10]);
    expect(graph.edges).toEqual([{ source: "a", target: "b", shared: 10, score: 0.25 }]);
    expect(input.coverage.presence).toMatchObject({ presenceOnlyMemberships: 19, qualifyingMemberships: 20 });
    expect(JSON.stringify(graph)).not.toContain("person-");
    await pool.query("delete from job_locks");
    const built = await runCommunityBuild({ db, config: loadConfig({ DATABASE_URL: url, SESSION_SECRET: "s".repeat(48) }),
      rest: new DisabledHelixAdapter(), workerName: "test", abortSignal: new AbortController().signal });
    expect(built).toMatchObject({ channels: 2, edges: 1 });
    const saved = (await pool.query("select recipe, graph, coverage from community_map_snapshots")).rows[0];
    expect(saved.recipe).toBe("finnish-presence-v4");
    expect(saved.graph).toEqual(graph);
    expect(saved.coverage.presence.presenceOnlyMemberships).toBe(19);
    expect(saved.coverage.thresholds).toEqual({ channelPeople: 5, sharedPeople: 3 });
  });

  it("recovers historical identities only from unambiguous same-day evidence, including name changes", async () => {
    await pool.query(`insert into chat_messages (twitch_message_id, broadcaster_user_id, twitch_stream_id, chatter_user_id, chatter_login, received_at)
      select person || '-' || day, 'evidence','evidence', person,
        case when person = 'renamed' then 'name-' || day else person end,
        date_trunc('day', now()) - make_interval(days => day)
      from unnest(array['person-1','renamed','ambiguous']) person cross join generate_series(1,2) day;
      insert into chat_messages (twitch_message_id, broadcaster_user_id, twitch_stream_id, chatter_user_id, chatter_login, received_at)
      values ('conflict','evidence','evidence','other','ambiguous',date_trunc('day', now()) - interval '1 day'),
        ('recycled-old','evidence','evidence','recycled','reused',date_trunc('day', now()) - interval '2 days'),
        ('recycled-new','evidence','evidence','other','reused',date_trunc('day', now()) - interval '1 day');
      insert into chat_membership_events (broadcaster_user_id, twitch_stream_id, chatter_login, event_type, received_at)
      select 'a','a',case when login = 'renamed' then 'name-' || day else login end,'part',
        date_trunc('day', now()) - make_interval(days => day) + interval '1 hour'
      from unnest(array['person-1','renamed','ambiguous','reused','person-2',null]) login cross join generate_series(1,2) day`);
    const input = await read();
    expect(input.memberships.map((row) => row.chatterId).sort()).toEqual(["person-1","renamed"]);
    expect(input.coverage.presence!.unresolvedEvents).toBeGreaterThan(0);
    expect(input.coverage.presence!.recoveredEvents).toBeGreaterThan(0);
  });

  it("does not turn reconnect bursts or events across midnight into repeated presence", async () => {
    await pool.query(`insert into chat_membership_events (broadcaster_user_id, twitch_stream_id, chatter_user_id, event_type, received_at)
      select 'a','a','person-1','join',date_trunc('day', now()) - interval '1 day' + make_interval(secs => n)
      from generate_series(-100,100) n`);
    expect((await read()).memberships).toEqual([]);
  });

  it("uses positive observations from partial snapshots, without counting duplicates or inferring absence", async () => {
    await pool.query(`insert into chat_presence_snapshots (broadcaster_user_id, twitch_stream_id, source, sampled_at, request_status)
      select 'a','a','helix.get_chatters',date_trunc('day', now()) - make_interval(days => day),'truncated' from generate_series(1,2) day;
      insert into chat_presence_observations (snapshot_id, broadcaster_user_id, twitch_stream_id, chatter_user_id, observed_at, source, dedupe_key)
      select id,'a','a','person-1',sampled_at,'helix.get_chatters',id::text from chat_presence_snapshots`);
    const input = await read();
    expect(input.memberships).toEqual([{ chatterId: "person-1", channelId: "a", weight: 0.25 }]);
    expect(input.coverage.presence!.snapshotChannels).toBe(1);
  });

  it("excludes widespread presence while retaining message evidence for that person", async () => {
    await pool.query(`insert into twitch_users (twitch_user_id) select 'room-' || n from generate_series(1,51) n;
      insert into stream_sessions (twitch_stream_id, broadcaster_user_id, started_at, is_finnish_eligible)
      select 'room-' || n,'room-' || n,now() - interval '10 days',true from generate_series(1,51) n;
      insert into chat_membership_events (broadcaster_user_id, twitch_stream_id, chatter_user_id, event_type, received_at)
      select 'room-' || n,'room-' || n,'person-1','join',date_trunc('day',now()) - make_interval(days => day)
      from generate_series(1,51) n cross join generate_series(1,2) day;
      insert into chat_messages (twitch_message_id, broadcaster_user_id, twitch_stream_id, chatter_user_id, received_at, shared_chat_source_channel_id)
      select 'chat-' || n,'a','a','person-1',date_trunc('day',now()) - interval '1 day','a' from generate_series(1,3) n`);
    expect((await read()).memberships).toEqual([{ chatterId: "person-1", channelId: "a", weight: 1 }]);
  });
});
