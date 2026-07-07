# Result 01-config-api: Config and API Hardening

## Summary
Added production config guardrails, admin bootstrap IDs, admin-only bot OAuth endpoints, token-status listing, and mandatory EventSub signature checks.

## Evidence
- `packages/config/src/index.ts` now validates production HTTPS URLs, secure cookies, real secrets, and required Twitch client config.
- `apps/api/src/routes.ts` now rejects EventSub webhook requests missing signature headers before storing payloads.
- `apps/api/src/routes.ts` now supports `/api/internal/bot-accounts/oauth/start` and `/api/internal/bot-accounts/oauth/callback`.

## Handoff
- Summary: production configuration fails fast and bot OAuth can persist encrypted bot tokens.
- Changed surfaces: config env schema, internal API routes, EventSub webhook route, session admin calculation.
- Contracts satisfied: no token values returned from API; existing DB tables reused.
- Assumptions: first production admin is bootstrapped with `ADMIN_TWITCH_USER_IDS`.
- Local checks: typecheck and build passed.
- Integration evidence: bot token rows are listed only with metadata and boolean token-presence flags.
- Risks: live OAuth redirect/callback still needs real Twitch credentials and matching registered redirect URI.

## Files changed
- packages/config/src/index.ts
- apps/api/src/routes.ts

## Decisions
- Keep local/private MVP privileged internal access, but make production mode strict.
- Reuse `bot_accounts` and `bot_account_tokens`; no migration needed.

## Risks
Bot OAuth callback requires the admin session cookie to remain available on the API route host.

## Verification run
- `corepack pnpm typecheck`: pass
- `corepack pnpm build`: pass

## Open questions
None blocking.
