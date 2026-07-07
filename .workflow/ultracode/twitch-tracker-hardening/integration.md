# Integration

## Accepted
- Production config validation, EventSub signature enforcement, configured-admin bootstrap, bot OAuth endpoints.
- DB-backed worker bot credential resolution with token refresh.
- Discovery pagination, rate-limit observations, and successful-poll offline reconciliation.
- Loop non-overlap guard and confirmation-based IRC join status.
- Internal bot account page, env example, and runbook updates.

## Rejected
None.

## Conflicts
None known.

## Decisions
- Use existing `bot_accounts` and `bot_account_tokens` tables rather than adding migrations.
- Keep env bot credentials supported as a bootstrap/fallback path.
- Treat live Twitch checks as operator follow-up because no credentials are available in this workspace.

## Final changes
See result files `01-config-api.md`, `02-worker-ingestion.md`, and `03-web-docs.md`.

## Verification still needed
Real Twitch OAuth, REST, IRC, and EventSub checks with operator-provided credentials.

## Remaining risks
Real Twitch OAuth, REST, IRC, and EventSub flows still require live credentials and public HTTPS callback testing.
