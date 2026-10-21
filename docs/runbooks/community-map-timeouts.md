# Community map timeout repair — 2026-10-20

## Production follow-up — 2026-10-21

The original fix was pushed to a feature branch while the VM auto-deployer watches
`main`; it had not been deployed. After operator-authorized promotion to main,
release `3a26825` deployed successfully but its message query still timed out at
90 seconds. The initial local benchmark below therefore did not establish a
complete production repair.

The follow-up moves privacy/bot classification after person/channel grouping.
Those predicates are constant for each group within the existing repeatable-read
transaction. Total-message and missing-session diagnostics still include all
messages; qualification, unknown-source and relayed diagnostics still apply
privacy filtering. Removing correlated predicates from the message scan allows
parallel joins and partial aggregation, without materializing every joined row.

A single bounded read-only production EXPLAIN ANALYZE for the completed window
`[2026-09-21, 2026-10-21)` completed in **64.306 seconds**, with the unchanged
90-second timeout and 32 MB work_mem while a backup was running. It processed
5,734,122 message rows, grouped them into 178,704 person/channel pairs and returned
107,218 message-qualified memberships. Only aggregate query-plan statistics were
retrieved. This measures the message query, not presence, layout or publication.
The 16 focused community integration tests, worker compilation and focused lint
passed for this follow-up. The original synthetic timings below describe the
first implementation, not this follow-up.

Release `15593f2` completed the message stage, but the subsequent presence stage
hit its separate 90-second timeout. One bounded read-only diagnostic of the
unchanged presence SQL completed in **113.281 seconds** over 5,793,392 events,
returning 260,155 qualified memberships. Query-rewrite experiments did not provide
reliable headroom under 90 seconds and were not retained. The presence stage now
has a **150-second statement limit**; the message stage remains at 90 seconds and
the overall build budget remains four minutes. No graph thresholds, identity or
privacy rules change. Actual end-to-end publication must verify this budget.

The production health report counted 76 failed builds and matching PostgreSQL
statement timeouts in 24 hours. The last successful snapshot was
`2026-10-10T03:02:57.079Z`. Working chat ingestion and worker heartbeats did not
establish that map generation was working.

## Supported cause and repair

Read-only inspection confirmed the deployed compact views and native indexes.
For the 30-day window ending October 20, PostgreSQL 16.14 estimated 5.65 million
message rows; each of the two message queries independently hashed the entire
13.27-million-row raw IRC relation. The presence query decoded a compact ID for
every message before grouping same-day identity evidence. The membership view's
`coalesce(source_override, '')` predicate also hid source-column statistics:
its eligible-event branch was estimated at one row. These are query/data-access
costs, not a missing timestamp index or an upstream Twitch restriction.

The repair shares one materialized message pass between membership and coverage
aggregation, deduplicates compact login/day/ID evidence before decoding, and reads
membership source filtering through the underlying normalized tables. The deployed
constraint permits only NULL or `!`-prefixed source overrides, so NULL exactly
represents the default `irc_membership` source. Identity and context joins match
the view. The recipe, weights, UTC boundaries, ambiguity rules, source attribution,
privacy filters, lease and timeout settings are unchanged. No schema migration
or index is required.

Non-executing production EXPLAIN confirms one message hash-join pass and a
parallel native membership scan in the candidate. A ten-minute baseline message
probe read 875 messages in 1.43 seconds, with an eight-second statement timeout.
During the October 20 investigation, no full-window production query, rebuild,
deployment or production write was performed.
The exact contribution of each cost to the production failures remains unmeasured;
the production-sized end-to-end build must still be verified during rollout.

## Reproduce locally

Use Node 24.19.0 and an isolated PostgreSQL instance on loopback port 55439 with
the local test role `benchmark`. Create the empty database
`community_map_benchmark_test`, apply the repository migrations, then run from
the repository root:

```sh
node packages/db/scripts/community-map-benchmark.mjs
```

The script generates only synthetic data: one million messages, 1.3 million raw
records, 60,000 membership events, 1,000 people and 100 channels across 30 UTC
days. It compares actual SQL templates with baseline revision
`d0b5f69642d9023c102a431a189dad1dafc6fddb`, checks full member/time/diagnostic
equivalence, warms the candidate, and records four candidate samples. A baseline
timeout is recorded as a failure, never a latency sample. Only the untimed
correctness reference disables nested loops if necessary; candidate measurements
use normal planner settings and the unchanged 90-second timeout / 32 MB work_mem.
`--reuse` reuses this dedicated synthetic fixture and checks its row counts.
Results are written next to the script as `community-map-results.json`.

### Measured result

The [saved result](../../packages/db/scripts/community-map-results.json) used
PostgreSQL **17.5 on Windows**, Node 24.19.0 and the workload above. Production
uses PostgreSQL **16.14 on Linux**; its complete runtime has not been measured.

The original presence query timed out at 90 seconds with normal planner settings.
Its synthetic plan estimated one eligible event and repeatedly scanned the
30,000-row identity CTE for 60,000 events. The candidate completed, and all member
IDs, first/last times and diagnostics matched unchanged baseline SQL under the
untimed reference planner override.

| Candidate input SQL, four completed warm samples | Median | Range |
| --- | ---: | ---: |
| Messages plus coverage | 3.488 s | 3.473–3.525 s |
| Presence | 1.795 s | 1.750–1.802 s |
| Combined | 5.277 s | 5.238–5.324 s |

These timings consume complete query results but exclude graph layout, category
enrichment and publication. The timed candidate had no failures. Its identity
evidence CTE materialized 30,000 unique records instead of one million message
records, and decoding occurs after that reduction. The message query materialized
one joined pass and 1,000 grouped memberships. The fixture is deliberately
repetitive; it does not establish production speed or memory use at a different
identity distribution. Production still needs a successful current snapshot.

Verification completed locally: all 352 tests in 43 files passed against the
isolated migrated PostgreSQL database, including actual threaded map publication.
Repository-wide type checking, source lint (`apps packages scripts`), worker
compilation, structure checks and `git diff --check` passed. Added regressions
cover cross-source duplicates, rare ambiguous identities, compact and escaped
IDs, non-default membership sources, and message window/time boundaries.
Container builds and deployment CI remain release checks.

## Production rollout (not executed)

1. Review and release the fix through the existing deployment coordination, with
   CI passing for the exact revision. Build the immutable worker image before
   replacing the running worker. Retain the previous worker image for rollback.
2. In `/srv/projects/twitch-tracker`, use the existing environment and both
   deployed Compose files. With `IMAGE_TAG` and `VCS_REF` set to the approved
   release, the worker-only build and replacement commands are:

   ```sh
   docker compose --env-file .env.production -f compose.yaml \
     -f /srv/projects/deployments/overrides/twitch-tracker.yaml build worker
   docker compose --env-file .env.production -f compose.yaml \
     -f /srv/projects/deployments/overrides/twitch-tracker.yaml \
     up -d --no-deps worker
   ```

   This requires a brief worker/IRC reconnect. Leave API, PostgreSQL and ingestion
   configuration running as configured; there is no database maintenance step.
3. Let the existing retry run after `retry_after` (and any old four-minute lease)
   expires, or use **Admin → Ingestion → Community map → Build now** once.
   Do not reset state or delete leases manually.
4. Verify the actual publication, not a heartbeat or skipped loop:

   ```sql
   BEGIN READ ONLY;
   SET LOCAL statement_timeout = '5s';
   SET LOCAL lock_timeout = '1s';
   SELECT s.status, s.last_success_at, s.retry_after,
          p.generated_at, p.window_start, p.window_end, p.valid
   FROM community_map_state s
   LEFT JOIN community_map_snapshots p ON p.id = s.snapshot_id
   WHERE s.id = 'current';
   ROLLBACK;
   ```

   Require `ready`, a new `last_success_at` matching the current valid snapshot's
   `generated_at`, and the latest due reporting window. Confirm the public map
   serves that snapshot and chat/raw/viewer ingestion continues. If the attempt
   fails, retain the previous valid snapshot and inspect that failed build;
   do not raise timeouts or repeatedly queue builds. Worker rollback uses the
   previous image with the same worker-only replacement command.
