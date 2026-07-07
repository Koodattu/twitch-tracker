# Final audit

## Scope

Audit for the first implementation increment, not the full persistent goal.

## Evidence

- Monorepo scaffold exists.
- Required apps/packages exist.
- Drizzle schema and migrations exist.
- Hono API route groups exist.
- Worker loop modules exist.
- Next.js pages exist.
- Docker Compose service definitions exist.
- Typecheck and build passed.
- Full local Docker Compose runtime passed.
- Migration container exited successfully and created 32 public tables.
- API health, web root, and internal ingestion page smoke tests passed through
  Caddy.
- Worker heartbeats reported all configured loops as `ok`.
- Synthetic EventSub receipt was persisted to `raw_eventsub_events`.
- OAuth/session routes exist; no-credentials auth smoke checks returned the
  expected anonymous, unauthorized, and not-configured states.
- EventSub subscription state table and worker reconciliation loop exist.
- EventSub raw events normalize into stream lifecycle state, `channel_events`,
  and `raids` for the initial event set.
- Aggregate rollups produced rows from a synthetic local sample, and the sample
  rows were cleaned up.
- Maintenance loop implements raw chat/raw payload redaction and stale
  assignment cleanup.
- Private/internal API routes allow local/private mode or logged-in admin
  access, with admin status sourced from product role or `admin_users`.
- Subject privacy state, privacy request ledger, and request event tables exist.
- Own Data privacy routes exist for public-profile opt-out, tracking opt-out,
  and data-deletion request creation.
- Internal privacy request completion route exists and applies data redaction.
- Synthetic privacy flow passed through local Compose and synthetic rows were
  cleaned up.
- Channel viewer-history and activity endpoints return aggregate-backed data.
- Channel page renders daily activity, viewer history, and recent chat buckets.
- Synthetic channel analytics flow passed through local Compose and synthetic
  rows were cleaned up.
- Stream activity endpoint returns viewer snapshots, activity buckets, channel
  events, raids, and totals.
- Stream page renders stream analytics sections.
- Synthetic stream activity flow passed through local Compose and synthetic
  rows were cleaned up.
- Twitch smoke runner exists and no-credential mode passes with skipped live
  checks.

## Not complete for full goal

- Real Twitch credential-backed REST/IRC/EventSub ingestion using the new smoke
  runner and a populated `.env`.
- Real Twitch OAuth callback/token refresh verification.
- Public launch policy copy, operator response procedure, final retention
  policy, and legal privacy review.

## Decision

Do not mark the persistent goal complete.
