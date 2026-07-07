# Packet 03-web-docs: Admin UI and Operator Docs

## Objective
Add a small internal bot accounts UI and document env values, bot scopes, and required operator actions.

## Context
The web app has an internal ingestion page but no bot account page. `.env.example` lacks bot OAuth callback/scopes/admin IDs.

## Sources
- apps/web/app/
- .env.example
- docs/runbooks/

## Ownership
Parent session.

## Write scope
- apps/web/app/
- .env.example
- docs/runbooks/

## Coordination rule
You are not alone in the codebase. Do not revert edits made by others. Adapt to nearby changes.

## Do
- Add internal page that links to bot OAuth start and shows account/token status.
- Update env example and runbook with exact scopes and checklist.

## Do not
- Build a large admin console.

## Expected output
Web build passes and docs are actionable.

## Verification
Typecheck, build, structure check.

## Handoff format
Result file with changed surfaces, decisions, risks, and verification.
