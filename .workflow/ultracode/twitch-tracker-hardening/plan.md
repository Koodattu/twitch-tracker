# Twitch Tracker Hardening

## Goal
Fix the highest-risk gaps from the deployment audit while keeping implementation scoped: production config guardrails, signed EventSub webhook enforcement, bot OAuth administration, DB-backed bot token use, discovery pagination/reconciliation, loop non-overlap, and operator docs.

## Success criteria
- Production mode fails fast on insecure public URLs, placeholder secrets, insecure cookies, or missing required Twitch config.
- EventSub webhook rejects missing or invalid signature headers before persisting payloads.
- Admin users can connect bot accounts through Twitch OAuth and see token/account status.
- Worker can use either env bot credentials or stored bot-account tokens.
- Finnish live stream discovery paginates and closes no-longer-seen live sessions only after a successful REST poll.
- Worker loops skip overlap instead of running concurrently.
- Docs and `.env.example` state required operator actions and bot scopes.

## Current context
The app already has Next.js, Hono, Drizzle, Postgres, worker loops, IRC/EventSub/REST adapters, privacy endpoints, and internal diagnostics. Real Twitch credentials are not available in this workspace.

## Constraints
- No deployment, commits, or destructive git operations.
- Do not print or require secrets.
- Use existing stack and patterns.
- Docker escalation may be unavailable, so verification must not depend solely on Compose.

## Risk level
High: changes affect auth, webhook trust boundary, ingestion correctness, and production boot behavior.

## Approval gates
No external account changes, deployments, migrations against production data, commits, or pushes without explicit approval.

## Mode
Workflow mode. Native subagents are available, but the active tool policy only permits spawning when the user explicitly asks for subagents or parallel delegation.

## Work packets
- 01-config-api: production guardrails, webhook signature enforcement, bot OAuth API.
- 02-worker-ingestion: DB-backed bot auth, discovery pagination/reconciliation, loop non-overlap.
- 03-web-docs: admin UI, env example, runbook notes.

## Eval contract
- Outcome: app is safer to configure and ready for real-token smoke testing, not public deployment.
- Shared surfaces: config env schema, API auth/webhook routes, worker bot auth/discovery loops, internal web UI, docs.
- Required checks: typecheck, build, structure check, and any targeted smoke that does not require real Twitch credentials.
- Blocking conditions: missing compile path, broken route imports, unsafe webhook acceptance, or inability to explain operator steps.
- Handoff evidence: changed files, verification output, remaining real-world checks.

## Integration policy
Keep changes narrow, do not alter schema unless unavoidable, and prefer existing tables and helpers.

## Verification plan
Run `corepack pnpm typecheck`, `corepack pnpm build`, and `node scripts/check-structure.mjs`. If network or Docker blocks deeper checks, report clearly.

## Completion criteria
All scoped patches are applied, compile/build checks pass or known unrelated blockers are reported, docs list required user actions and Twitch scopes.
