# Twitch Tracker

A production-oriented Twitch analytics stack for Finnish-language streams. It includes a Next.js web app, Hono API, ingestion worker, PostgreSQL, automatic HTTPS through Caddy, migrations, and verified off-host backups.

## Development

Use Node 24.19 and the pinned pnpm version:

```powershell
corepack enable
corepack prepare pnpm@11.21.0 --activate
pnpm install --frozen-lockfile
pnpm dev
```

Run the repository checks with:

```powershell
pnpm check:structure
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

Copy `.env.example` to `.env` for local development. Twitch ingestion and EventSub are disabled by default so local startup does not make live Twitch calls unexpectedly.

## Production

Production Compose is fail-closed: it requires a public hostname, immutable administrator ID, Docker secret files, HTTPS, and an off-host backup mount. It pins Node, Caddy, and the latest PostgreSQL 16 patch by digest; PostgreSQL stays on major 16 because existing volumes require a deliberate major-version migration.

Follow [the production deployment runbook](docs/runbooks/production-deploy.md). Public launch still requires the privacy/legal decisions and live Twitch verification listed there.
