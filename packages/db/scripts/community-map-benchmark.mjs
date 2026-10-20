import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";

// Synthetic data only. Create and migrate this empty database before running.
const client = new pg.Client({
  host: "127.0.0.1", port: 55439, user: "benchmark", database: "community_map_benchmark_test",
  options: "-c timezone=UTC -c statement_timeout=90000 -c lock_timeout=2000 -c work_mem=32MB"
});
const baselineRevision = "d0b5f69642d9023c102a431a189dad1dafc6fddb";
const root = new URL("../../../", import.meta.url);
const inputPath = "apps/worker/src/community-input.ts";
const presencePath = "apps/worker/src/community-presence.ts";
const baseline = (path) => execFileSync("git", ["-c", `safe.directory=${process.cwd().replaceAll("\\", "/")}`,
  "show", `${baselineRevision}:${path}`], { encoding: "utf8", windowsHide: true });
// Extract the actual SQL templates, rejecting any new interpolation we do not handle.
function queries(source, observed = "") {
  return [...source.matchAll(/sql`([\s\S]*?)`/g)].map((match) => {
    const text = match[1].replaceAll("${observed}", observed)
      .replaceAll("${claim.windowStart}", "'2026-09-20T00:00:00Z'::timestamptz")
      .replaceAll("${claim.windowEnd}", "'2026-10-20T00:00:00Z'::timestamptz")
      .replaceAll("${maxCommunityMemberships + 1}", "500001");
    assert(!text.includes("${"), "Unhandled SQL interpolation");
    return text;
  }).filter((query) => !query.trim().startsWith("set local"));
}
const oldInput = baseline(inputPath);
const observed = oldInput.match(/const observed = sql`([\s\S]*?)`;/)[1];
const oldQueries = queries(oldInput, observed).slice(1);
const newQueries = queries(await readFile(new URL(inputPath, root), "utf8"));
const oldPresence = queries(baseline(presencePath))[0];
const newPresence = queries(await readFile(new URL(presencePath, root), "utf8"))[0];
assert.equal(oldQueries.length, 2);
assert.equal(newQueries.length, 1);
await client.connect();
try {
  if (!process.argv.includes("--reuse")) {
    assert.equal((await client.query("select count(*)::int n from twitch_users")).rows[0].n, 0, "Needs an empty migrated fixture");
    await client.query(`
    insert into twitch_users(twitch_user_id,login)
    select n::text,'person-'||n from generate_series(1,1000) n
    union all select (10000+n)::text,'channel-'||n from generate_series(1,100) n;
    insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,is_finnish_eligible)
    select (10000+n)::text,(10000+n)::text,'2026-09-01'::timestamptz,true from generate_series(1,100) n;
    insert into raw_irc_messages(id,raw_line,received_at,unrelayed_source)
    select md5(n::text)::uuid,'','2026-09-20'::timestamptz + (n%30)*interval '1 day',true
    from generate_series(1,1300000) n;
    insert into chat_messages(twitch_message_id,broadcaster_user_id,twitch_stream_id,chatter_user_id,chatter_login,received_at,raw_irc_message_id)
    select encode_chat_message_id(md5(n::text)::uuid::text),
      encode_external_key((10001+(n%100))::text),encode_external_key((10001+(n%100))::text),
      encode_external_key((1+(n%1000))::text),'person-'||(1+(n%1000)),
      '2026-09-20'::timestamptz + ((n/1000)%30)*interval '1 day',md5(n::text)::uuid
    from generate_series(1,1000000) n;
    insert into membership_event_contexts(broadcaster_user_id,twitch_stream_id)
    select (10000+n)::text,(10000+n)::text from generate_series(1,100) n;
    insert into membership_event_identities(chatter_login)
    select 'person-'||n from generate_series(1,1000) n;
    insert into membership_events(id,received_at,created_at,context_id,identity_id,event_time_kind,identity_time_kind,is_join)
    select md5(n::text)::uuid,
      '2026-09-20'::timestamptz + ((n/1000)%30)*interval '1 day','2026-09-20'::timestamptz,
      c.id,i.id,0,0,true
    from generate_series(1,60000) n
    join membership_event_contexts c on c.broadcaster_user_id=(10001+(n%100))::text
    join membership_event_identities i on i.chatter_login='person-'||(1+(n%1000));
    analyze chat_message_records; analyze raw_irc_records; analyze stream_sessions;
    analyze membership_events; analyze membership_event_contexts; analyze membership_event_identities;
    `);
  }
  assert.deepEqual((await client.query(`select
    (select count(*)::int from chat_messages) messages,
    (select count(*)::int from raw_irc_messages) raw,
    (select count(*)::int from chat_membership_events) events`)).rows[0],
  { messages: 1000000, raw: 1300000, events: 60000 });
  const report = { baselineRevision, node: process.version, postgres: (await client.query("select version() v")).rows[0].v,
    workload: { messages: 1000000, rawRecords: 1300000, membershipEvents: 60000, people: 1000, channels: 100, days: 30 },
    samples: { before: [], after: [] }, plans: {} };
  const canonical = (value) => JSON.parse(JSON.stringify(value));
  const sortMembers = (members) => members.sort((a, b) => `${a.chatterId}/${a.channelId}`.localeCompare(`${b.chatterId}/${b.channelId}`));
  async function run(after) {
    const start = performance.now();
    const rows = [];
    for (const query of after ? newQueries : oldQueries) rows.push((await client.query(query)).rows);
    const messageMs = performance.now() - start;
    const presence = (await client.query(after ? newPresence : oldPresence)).rows[0];
    const presenceMs = performance.now() - start - messageMs;
    const { members, ...diagnostics } = after ? rows[0][0] : { members: rows[0], ...rows[1][0] };
    // jsonb timestamps and driver Date objects have different textual spellings.
    for (const member of members) { member.first = new Date(member.first).toISOString(); member.last = new Date(member.last).toISOString(); }
    return { times: { messageMs, presenceMs, totalMs: messageMs + presenceMs },
      output: canonical({ members: sortMembers(members), diagnostics, presence: { ...presence, members: sortMembers(presence.members) } }) };
  }
  let expected;
  try {
    expected = (await run(false)).output;
  } catch (error) {
    if (error.code !== "57014") throw error;
    report.baselineFailure = { code: error.code, timeoutMs: 90000 };
    // A failed run is not a latency sample. Obtain the correctness oracle from
    // unchanged baseline SQL with only its nested-loop plan disabled locally.
    // Never use this override for candidate timings or production settings.
    await client.query("set enable_nestloop=off");
    try { expected = (await run(false)).output; }
    finally { await client.query("reset enable_nestloop"); }
    report.equivalenceReference = "Baseline SQL with enable_nestloop=off (untimed)";
  }
  assert.equal(expected.members.length, 1000);
  assert.equal(expected.presence.members.length, 1000);
  assert.equal(expected.presence.recoveredEvents, 60000);
  assert.deepEqual((await run(true)).output, expected);
  for (let round = 0; round < 4; round++) {
    for (const after of report.baselineFailure ? [true] : round % 2 ? [true, false] : [false, true]) {
      const result = await run(after);
      assert.deepEqual(result.output, expected);
      report.samples[after ? "after" : "before"].push(result.times);
    }
  }
  for (const [label, query] of Object.entries({ beforeMessages: oldQueries[0], afterMessages: newQueries[0], beforePresence: oldPresence, afterPresence: newPresence })) {
    const executed = !(report.baselineFailure && label === "beforePresence");
    const plan = (await client.query(`explain (${executed ? "analyze, buffers, timing off, " : ""}format json) ${query}`)).rows[0]["QUERY PLAN"][0];
    const ctes = {};
    function visit(node) {
      if (node["Subplan Name"]?.startsWith("CTE ")) ctes[node["Subplan Name"]] = node["Actual Rows"];
      for (const child of node.Plans ?? []) visit(child);
    }
    visit(plan.Plan);
    report.plans[label] = {
      executed, executionMs: plan["Execution Time"], sharedReadBlocks: plan.Plan["Shared Read Blocks"],
      tempReadBlocks: plan.Plan["Temp Read Blocks"], tempWrittenBlocks: plan.Plan["Temp Written Blocks"], ctes
    };
  }
  await writeFile(new URL("community-map-results.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ workload: report.workload, baselineFailure: report.baselineFailure,
    samples: report.samples, equivalence: "All membership identities, times and diagnostics match" }, null, 2));
} finally {
  await client.end();
}
