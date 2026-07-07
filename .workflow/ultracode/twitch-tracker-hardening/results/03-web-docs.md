# Result 03-web-docs: Admin UI and Operator Docs

## Summary
Added an internal bot accounts page, forwarded cookies for internal pages, updated env examples, and documented required bot scopes and operator setup.

## Evidence
- `apps/web/app/internal/bot-accounts/page.tsx` lists bot account/token metadata and links to bot OAuth start.
- `apps/web/app/internal/ingestion/page.tsx` forwards cookies for production admin access.
- `.env.example` includes bot OAuth callback, bot scopes, and admin bootstrap IDs.
- `docs/runbooks/twitch-smoke.md` lists the operator flow and scopes.

## Handoff
- Summary: operators have a simple UI path to connect bot accounts and see token state.
- Changed surfaces: internal web navigation/page, fetch helper, env example, runbook.
- Contracts satisfied: UI does not expose token values.
- Assumptions: `/api/*` routes are served through the same public host or reverse proxy as the web UI.
- Local checks: web typecheck/build passed.
- Integration evidence: production build includes `/internal/bot-accounts`.
- Risks: browser click-through requires real OAuth configuration and matching Twitch redirect URI.

## Files changed
- apps/web/app/internal/bot-accounts/page.tsx
- apps/web/app/internal/ingestion/page.tsx
- apps/web/app/layout.tsx
- apps/web/app/api-client.ts
- apps/web/app/globals.css
- .env.example
- docs/runbooks/twitch-smoke.md

## Decisions
- Keep the admin UI intentionally small: connect and inspect, not full account management yet.

## Risks
No enable/disable controls yet; use DB/admin tooling or env config until that is added.

## Verification run
- `corepack pnpm typecheck`: pass
- `corepack pnpm build`: pass
- `node scripts/check-structure.mjs`: pass

## Open questions
None blocking.
