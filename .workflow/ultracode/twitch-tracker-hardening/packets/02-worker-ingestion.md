# Packet 02-worker-ingestion: Worker Ingestion Reliability

## Objective
Make worker ingestion use DB-backed bot tokens, avoid loop overlap, paginate Finnish stream discovery, record REST rate limits, and reconcile offline streams after successful polls.

## Context
Discovery currently fetches one page using env token only. Loop intervals can overlap when a run takes longer than its interval.

## Sources
- apps/worker/src/worker.ts
- apps/worker/src/loops/common.ts
- apps/worker/src/loops/discovery.ts
- apps/worker/src/loops/assignment.ts
- apps/worker/src/loops/irc.ts

## Ownership
Parent session.

## Write scope
- apps/worker/src/

## Coordination rule
You are not alone in the codebase. Do not revert edits made by others. Adapt to nearby changes.

## Do
- Keep env bot credentials as bootstrap fallback.
- Prefer enabled DB bot accounts when env credentials are absent.
- Only close streams after successful REST pages.

## Do not
- Change Twitch API adapter contracts unless required.

## Expected output
Worker loops compile and report useful heartbeat summaries.

## Verification
Typecheck and build.

## Handoff format
Result file with changed surfaces, decisions, risks, and verification.
