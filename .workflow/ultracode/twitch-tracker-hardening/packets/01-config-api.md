# Packet 01-config-api: Config and API Hardening

## Objective
Add production config validation, require signed EventSub webhooks, and add admin-only bot OAuth endpoints.

## Context
The API has user OAuth and internal routes, but bot tokens are currently env-only and EventSub accepts unsigned requests.

## Sources
- packages/config/src/index.ts
- apps/api/src/routes.ts

## Ownership
Parent session.

## Write scope
- packages/config/src/index.ts
- apps/api/src/routes.ts

## Coordination rule
You are not alone in the codebase. Do not revert edits made by others. Adapt to nearby changes.

## Do
- Validate production env safety at startup.
- Add admin bootstrap via configured Twitch user IDs.
- Store bot OAuth tokens in existing bot account tables.
- Reject EventSub requests with missing or invalid signature headers.

## Do not
- Add new migrations unless existing tables cannot support the flow.
- Remove local/private MVP privileged mode.

## Expected output
Config and API changes compile cleanly.

## Verification
Typecheck and build.

## Handoff format
Result file with changed surfaces, decisions, risks, and verification.
