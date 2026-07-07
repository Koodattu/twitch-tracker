# Final report

## Outcome

First implementation increment complete. The repository now has a verified
local Docker Compose baseline with API, web, worker, PostgreSQL migrations,
backup, Twitch OAuth/session persistence, EventSub subscription state,
EventSub event normalization, PostgreSQL rollups, raw retention/stale
assignment maintenance, subject privacy controls, synthetic EventSub receipt,
and no-credentials ingestion loops running. The persistent goal is not complete.

## What changed

- Added pnpm TypeScript monorepo scaffold.
- Added shared config, shared DTOs, Twitch adapter package, and Drizzle DB
  package.
- Added 32-table Drizzle schema and generated migrations.
- Added Hono API with health, public analytics, auth, internal, private, and
  EventSub webhook route groups.
- Added modular worker loops, REST discovery normalization path, chat
  assignment, IRC raw/message/membership persistence, EventSub reconciliation,
- EventSub event normalization, OAuth token validation/refresh, aggregate
  rollups, raw retention redaction, and stale assignment cleanup.
- Added Next.js public analytics pages and ingestion diagnostics page.
- Added Docker Compose with caddy, web, api, worker, postgres, migrate, and
  backup.
- Added admin-aware private/internal API access and bounded private MVP detail
  endpoints for chatter and stream raw inspection.
- Added privacy request/state tables, Own Data privacy controls, public
  suppression checks, tracking opt-out enforcement in assignment, and internal
  deletion completion with subject-linked data redaction.
- Added PostgreSQL-backed channel viewer-history and activity endpoints, plus
  channel-page rendering for daily activity, viewer snapshots, and recent chat
  buckets.
- Added PostgreSQL-backed stream activity endpoint, plus stream-page rendering
  for viewer snapshots, activity buckets, channel events, and raids.
- Added latest-viewer and chat-assignment enrichment to the live stream ranking
  API, current-viewer display to the homepage, and viewer-ranked assignment
  priority consumed by the IRC join loop.
- Added `corepack pnpm smoke:twitch` for no-credential and live Twitch
  verification, plus a runbook for app auth, Helix, bot token, IRC, EventSub
  list, and signed callback checks.

## Verification

- `corepack pnpm install`: pass, with expected local Node engine warning.
- `corepack pnpm typecheck`: pass.
- `corepack pnpm build`: pass.
- `node scripts/check-structure.mjs`: pass.
- `corepack pnpm --filter @twitch-tracker/db db:generate`: pass.
- `docker compose config`: pass, with Docker user config access warnings.
- Full local `docker compose up --build -d`: pass.
- Migration container: exited 0; PostgreSQL public schema contains 32 tables.
- API health smoke test through Caddy: pass, HTTP 200.
- Web root, Own Data page, and internal ingestion page through Caddy: pass,
  HTTP 200.
- Worker heartbeats: all seven loops reported `ok`.
- Synthetic aggregation sample produced rows in stream, channel daily,
  chatter-channel, and chatter daily aggregate tables; sample rows were cleaned
  up after verification.
- Backup sidecar: created a local dump file.
- Synthetic EventSub notification: accepted by API and persisted to
  `raw_eventsub_events`.
- Synthetic EventSub normalizer sample processed `stream.online`,
  `channel.update`, `channel.raid`, and `stream.offline` into stream lifecycle
  state, four `channel_events`, and one `raids` row; sample rows were cleaned
  up after verification.
- Synthetic retention sample redacted raw chat text, raw IRC line/tags, raw
  EventSub payload, raw Helix payloads, and closed an ended-stream assignment;
  synthetic rows and derived aggregate rows were cleaned up after verification.
- Synthetic privacy flow verified through Compose: migration applied to 35
  tables, logged-in privacy state returned, tracking opt-out completed and
  closed assignment, data-deletion request completed through internal API,
  subject-linked chat/raw/aggregate/session data was redacted or removed, and
  synthetic rows were cleaned up.
- Synthetic channel analytics flow verified through Compose: seeded a channel,
  stream, viewer snapshots, daily stats, and activity bucket; API returned
  viewer-history and activity data; channel page returned HTTP 200; synthetic
  rows were cleaned up.
- Synthetic stream activity flow verified through Compose: seeded a stream,
  snapshots, activity bucket, channel event, and raid; API returned all sections;
  stream page returned HTTP 200; synthetic rows and worker-derived aggregates
  were cleaned up.
- Synthetic live-ranking flow verified through Compose: seeded two live Finnish
  streams with viewer counts `120` and `7`; `/api/streams/live` returned them
  in that order with `joined` counting as tracked and `desired` not counting as
  tracked; homepage returned HTTP 200 with the live stream after revalidation;
  a short one-off worker run set assignment `priority_score` values from latest
  viewer snapshots; synthetic rows were cleaned up.
- Auth no-credentials smoke checks: `/api/me` returns anonymous session,
  `/api/me/data` returns 401, and OAuth start returns 501 when Twitch OAuth is
  not configured.
- `corepack pnpm smoke:twitch`: pass; live Twitch checks were skipped because
  credentials are not configured.

## Final audit

The current increment satisfies the scaffold and baseline implementation
requirements in the eval contract. It does not satisfy the full product goal
yet.

## Skipped checks

- Real Twitch API/IRC/EventSub calls were not run because credentials are not
  configured in this environment.

## Remaining risks

- Real Twitch OAuth callback and token refresh were not run with credentials.
- IRC chat connection code exists and persists raw/messages/membership events,
  but it has not been exercised against Twitch credentials. The smoke runner now
  provides the command to do this.
- EventSub subscription reconciliation exists, but it has not been exercised
  against Twitch with a production HTTPS callback. The smoke runner now provides
  the signed callback challenge check.
- Baseline technical retention and privacy request controls exist, but public
  launch still needs final policy copy, operator response procedure, final
  retention settings, and privacy/legal review.
- Local Node version is newer than the target Node LTS runtime.

## Next useful step

Populate `.env` with real Twitch app and bot credentials, then run
`corepack pnpm smoke:twitch -- --require-live`. With public HTTPS API routing,
also run `corepack pnpm smoke:twitch -- --require-live --eventsub-callback`.
After that, finish public launch privacy/legal policy and operator procedure.
