# Eval contract

## Goal

Implement the Twitch Tracker PRD as a working Node.js LTS + pnpm TypeScript
monorepo with web, API, worker, PostgreSQL, migrations, Docker Compose, and
adapter boundaries for Twitch integrations.

## Success criteria

- The monorepo package manifests and workspace config are present.
- Shared config validates all required environment categories with Zod.
- Shared database package defines the initial PRD table groups through Drizzle
  schema files.
- API package exposes Hono routes for health, streams, channels, chatters,
  internal diagnostics, auth, and EventSub webhooks.
- Worker package contains modular loops for discovery, user hydration,
  assignment, IRC, EventSub, aggregation, and maintenance.
- Web package contains Next.js routes for live streams, channels, streams,
  chatters, own data, and ingestion diagnostics.
- Docker Compose contains caddy, web, api, worker, postgres, migrate, and backup
  services.
- Twurple is not used as a domain model and any SDK usage is behind adapters.

## Integration surfaces

- `package.json`, `pnpm-workspace.yaml`, TypeScript config.
- `packages/config` public config API.
- `packages/db` schema and migration scripts.
- `packages/twitch` adapter interfaces.
- `apps/api` REST route contracts.
- `apps/worker` loop contracts.
- `apps/web` frontend route expectations.
- `compose.yaml`, Caddy config, and environment examples.

## Downstream consumers

- API and worker consume config and DB packages.
- API and worker consume Twitch adapters.
- Web consumes API contracts.
- Docker Compose consumes app package scripts and Dockerfiles.
- Operators consume environment examples and diagnostics.

## Required checks

- File existence check for all planned apps/packages/services.
- Dependency installation or documented skip reason.
- Typecheck/build/test scripts where dependencies are available.
- Static inspection of route/schema/worker loop coverage.
- Docker Compose config validation if Docker Compose is available.

## Deliverables

- Workflow artifacts under `.workflow/ultracode/implement-twitch-tracker`.
- Application scaffold and source files.
- Docker Compose and supporting infrastructure files.
- Updated docs if implementation choices differ from the PRD.
- Final report with verification evidence and remaining gaps.

## Blocking conditions

- User approval is required for real deployment, production credentials,
  destructive operations, package publication, or running migrations against any
  non-local database.
- If dependency installation is unavailable due missing tooling or network
  restrictions, implementation can continue but full verification remains
  incomplete.
