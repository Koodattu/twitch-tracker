# Result 05-verification: Verification

## Summary

Ran the available local verification for this implementation increment,
including full local Docker Compose runtime checks.

## Evidence

- Structure check passed: `Structure check passed (17 paths).`
- Dependency install passed with expected Node engine warning.
- Typecheck passed for all workspace projects.
- Build passed for all workspace projects.
- Drizzle generated migrations for the 32-table schema.
- Docker Compose config rendered successfully.
- API health smoke test returned HTTP 200 and `{"data":{"ok":true,...}}`.
- Full local `docker compose up --build -d` completed successfully.
- Migrate service exited 0.
- PostgreSQL public schema contained 32 tables after migration.
- Web root, Own Data page, and internal ingestion page returned HTTP 200
  through Caddy.
- Worker heartbeats reported discovery, user hydration, assignment, IRC,
  EventSub, aggregation, and maintenance as `ok`.
- Backup sidecar produced a local dump file.
- Synthetic EventSub notification was accepted and persisted as
  `local-test-message-2`.
- Synthetic EventSub normalizer sample processed `stream.online`,
  `channel.update`, `channel.raid`, and `stream.offline`; raw rows were marked
  `processed`, four `channel_events` rows and one `raids` row were created, and
  stream lifecycle state was updated.
- OAuth no-credentials route checks returned expected anonymous, unauthorized,
  and not-configured responses.
- Synthetic aggregation data rolled up into `stream_activity_buckets`,
  `channel_daily_stats`, `chatter_channel_activity_buckets`, and
  `chatter_daily_stats`; sample rows were cleaned up.
- Synthetic live-ranking data returned from `/api/streams/live` in viewer-count
  order with latest snapshot counts and conservative chat tracking status.
- A short one-off worker run with `TWITCH_BOT_LOGIN=syntheticbot` recorded
  assignment heartbeat details `{"topViewerCount": 120,
  "assignmentsDesired": 2}` and persisted `priority_score` values `120` and
  `7` for the synthetic streams.
- The homepage returned HTTP 200 and rendered the live-ranking viewer summary
  from seeded data after revalidation.
- Synthetic live-ranking rows were cleaned up from users, streams, snapshots,
  aggregates, assignments, bot account, and smoke worker heartbeat tables.

## Handoff

Handoff:
- Summary: The current baseline is buildable, smoke-tested, and runs locally
  through Compose without Twitch credentials.
- Changed surfaces: workflow result notes.
- Contracts satisfied: verification evidence captured.
- Assumptions: Docker config access warnings are environmental and do not
  invalidate Compose YAML.
- Local checks: listed above.
- Integration evidence: commands returned exit code 0 after fixes.
- Risks: Real Twitch credential-backed REST/IRC/EventSub verification has not
  been run yet.

## Files changed

Workflow result files.

## Decisions

Do not mark the persistent goal complete yet because real Twitch REST/IRC/
EventSub/OAuth verification and public-launch controls still need
implementation/verification.

## Risks

The app builds and runs locally under Compose, but it is not production-complete.

## Verification run

- `node scripts/check-structure.mjs`
- `corepack pnpm install`
- `corepack pnpm typecheck`
- `corepack pnpm build`
- `corepack pnpm --filter @twitch-tracker/db db:generate`
- `docker compose config`
- API health smoke through `Invoke-WebRequest`
- Full local `docker compose up --build -d`
- Migration table-count check through `psql`
- Worker heartbeat check through `psql`
- Web/internal page smoke tests through `Invoke-WebRequest`
- Synthetic EventSub webhook POST and database persistence check
- Synthetic EventSub normalizer webhook/restart/query/cleanup check through
  `Invoke-WebRequest` and `psql`
- Auth no-credentials smoke checks through `Invoke-WebRequest`
- Synthetic aggregation insert/restart/query/cleanup check through `psql`
- Synthetic live-ranking insert/query/homepage/one-off-worker/cleanup check
  through `psql`, `Invoke-RestMethod`, `Invoke-WebRequest`, and
  `docker compose run`

## Open questions

None for this increment.
