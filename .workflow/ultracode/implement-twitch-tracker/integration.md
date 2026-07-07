# Integration

## Accepted

- Accepted both explorer reports.
- Accepted PRD table names over older architecture-note names.
- Accepted API-owned access control and Deployment Mode enforcement in route
  handlers.
- Accepted adapter boundaries for Twitch REST, IRC, and EventSub.

## Rejected

- No agent output was rejected.

## Conflicts

- No file edit conflicts occurred because agents were read-only.

## Decisions

- Use Corepack-managed pnpm in root scripts because the local shell lacks a
  standalone `pnpm` shim.
- Keep `@twurple/*` as optional SDK candidates behind adapters; first code uses
  project-owned interfaces and fetch-based OAuth, Helix, and EventSub adapters.
- Use a project-owned TLS IRC socket adapter for the first IRC implementation so
  raw lines, assignment state, reconnect behavior, JOIN/PART, and capacity logic
  remain under application control.
- Keep EventSub webhook receipt in Hono and reconcile subscriptions from the
  worker through Twitch's REST endpoints.
- Include EventSub event type in the channel-event idempotency key because
  `stream.online` and `stream.offline` can share the same stream ID.
- Make `.env` optional for local Compose config while providing local-only
  defaults for required non-secret development values.
- Redact raw text and payload columns for retention instead of deleting ledger
  rows so normalized analytics and raw references remain stable.
- Allow private/internal API access in production only for logged-in admins from
  the product role or explicit `admin_users` table.
- Add subject privacy state and request ledgers so Own Data users can opt out
  of public profile exposure or tracking, and admins can complete deletion
  requests with auditable redaction.

## Final changes

- Added monorepo package/app scaffold.
- Added Drizzle schema and generated migrations.
- Added Hono API route baseline.
- Added modular worker loop baseline plus REST discovery, assignment, IRC
  persistence, EventSub reconciliation and normalization, OAuth token
  maintenance, aggregate rollup paths, and retention/stale-assignment
  maintenance.
- Added privacy request/state tables, Own Data privacy APIs, internal privacy
  request completion, public suppression checks, and assignment opt-out
  enforcement.
- Added PostgreSQL-backed channel viewer-history and activity API endpoints,
  and rendered channel daily stats, viewer snapshots, and recent chat buckets
  on the channel page.
- Added PostgreSQL-backed stream activity API endpoint, and rendered stream
  viewer snapshots, activity buckets, channel events, and raids on the stream
  page.
- Enriched live stream ranking with latest viewer snapshots and chat-assignment
  state, rendered current viewers on the homepage, and made assignment/IRC
  ordering consume viewer-ranked `priorityScore`.
- Added a Twitch smoke runner and runbook for live credential verification of
  app auth, Helix, bot token, IRC login, EventSub list, and optional signed
  callback challenge.
- Added Next.js analytics/diagnostics page baseline.
- Added Docker Compose and Caddy configuration.

## Verification completed

- Full `docker compose up --build -d` runtime verification.
- Local Postgres migration execution through the migrate service.
- API health, web root, and internal ingestion HTTP smoke tests through Caddy.
- Worker heartbeat check for all seven loops.
- Synthetic EventSub notification persisted through the webhook route.
- Synthetic EventSub normalizer sample produced stream lifecycle state, four
  `channel_events`, and one `raids` row, then was cleaned up.
- Synthetic aggregation sample rolled up into all aggregate table families and
  was cleaned up.
- Synthetic retention sample redacted raw chat text, raw IRC line/tags, raw
  EventSub payload, raw Helix payloads, and closed an ended-stream assignment,
  then was cleaned up.
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
- Synthetic live-ranking flow verified through Compose: seeded two Finnish live
  streams with viewer snapshots, API returned `120` before `7`, joined chat
  assignment counted as tracked while desired assignment did not, homepage
  returned HTTP 200 with the live stream, and a short one-off worker run set
  assignment `priority_score` values from latest viewer snapshots. Synthetic
  rows were cleaned up.
- Auth no-credentials route smoke checks.
- Twitch smoke no-credential mode passed and reported live checks as skipped
  without exposing token values.

## Verification still needed

- Real Twitch IRC/EventSub/REST run with bot credentials.
- Real Twitch OAuth callback/token refresh run with user credentials.

## Remaining risks

- Local Node is `v24.4.1`, while target runtime is Node 22 LTS.
- Docker reports access denied reading `C:\Users\Juha\.docker\config.json`, but
  `docker compose config` still succeeds.
- Baseline technical retention and opt-out/deletion request controls exist, but
  public launch still needs final policy copy, response procedure, and
  privacy/legal review.
