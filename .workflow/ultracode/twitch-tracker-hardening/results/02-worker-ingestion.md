# Result 02-worker-ingestion: Worker Ingestion Reliability

## Summary
Added DB-backed bot credential resolution and refresh, discovery pagination/rate-limit recording/offline reconciliation, loop overlap prevention, and confirmation-based IRC join state.

## Evidence
- `apps/worker/src/bot-auth.ts` resolves env credentials or enabled DB bot tokens and refreshes expired DB tokens.
- `apps/worker/src/loops/discovery.ts` paginates `/streams?language=fi`, records rate-limit observations, and closes missing live sessions only after a complete successful poll.
- `apps/worker/src/loops/common.ts` skips overlapping interval runs.
- `apps/worker/src/loops/irc.ts` marks assignments `joining` after sending JOIN and `joined` after Twitch confirmation.

## Handoff
- Summary: worker can start from env credentials or bot tokens connected through admin UI.
- Changed surfaces: worker credential resolution, discovery, assignment, IRC, rest adapter enablement.
- Contracts satisfied: no secrets logged or returned.
- Assumptions: env access tokens are still operator-managed; DB OAuth tokens can refresh using stored refresh token and Twitch client secret.
- Local checks: typecheck, build, structure check, and no-credential smoke passed.
- Integration evidence: assignment and IRC loops share `resolvePrimaryBotCredentials`.
- Risks: live IRC join confirmation behavior still needs real Twitch IRC testing.

## Files changed
- apps/worker/src/bot-auth.ts
- apps/worker/src/worker.ts
- apps/worker/src/loops/common.ts
- apps/worker/src/loops/discovery.ts
- apps/worker/src/loops/assignment.ts
- apps/worker/src/loops/irc.ts

## Decisions
- Use a 20-page discovery cap and skip offline reconciliation if pagination is truncated.
- Store rate-limit observations for each discovery page.

## Risks
Large reconciliation is currently row-by-row; acceptable for MVP, but a set-based update is better at larger scale.

## Verification run
- `corepack pnpm typecheck`: pass
- `corepack pnpm build`: pass
- `corepack pnpm smoke:twitch`: pass with expected live checks skipped

## Open questions
None blocking.
