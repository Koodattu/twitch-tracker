# Twitch Tracker

A production-oriented Twitch analytics stack for Finnish-language streams. It includes a Next.js web app, Hono API, ingestion worker, PostgreSQL, automatic HTTPS through Caddy, migrations, and verified off-host backups.

## Development

Use Node 24.19 and the pinned pnpm version:

```powershell
corepack enable
corepack prepare pnpm@11.21.0 --activate
pnpm install --frozen-lockfile
```

Use `.env.example` as a configuration reference and export the values needed by each process before starting it. The API, worker, and migration scripts read process environment variables; copying this file alone does not load them. Point `DATABASE_URL` at a designated local development database. Twitch ingestion and EventSub are disabled by default. Then migrate and start:

```powershell
pnpm --filter @twitch-tracker/db db:migrate
pnpm dev
```

For a self-contained walkthrough using a disposable database and synthetic data, see [the local QA setup](work/goal-improvement/README.md). It includes browser regression commands and review evidence.

Run the repository checks with:

```powershell
pnpm check:structure
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

## Production

Production Compose is fail-closed: it requires a public hostname, immutable administrator ID, private environment values, HTTPS, and an off-host backup mount. It pins Node, Caddy, and the latest PostgreSQL 16 patch by digest; PostgreSQL stays on major 16 because existing volumes require a deliberate major-version migration.

Follow [the production deployment runbook](docs/runbooks/production-deploy.md). Public launch still requires the privacy/legal decisions and live Twitch verification listed there.
