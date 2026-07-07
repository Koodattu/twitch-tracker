# Implement Twitch Tracker

## Goal

Implement the Twitch Tracker technical PRD end to end, starting from the current
docs-only repository and moving toward a working single-server Docker Compose
application with web, API, worker, PostgreSQL, migrations, and backup support.

## Success criteria

- TypeScript monorepo exists with `apps/web`, `apps/api`, `apps/worker`, and
  shared packages.
- PostgreSQL/Drizzle schema exists for the PRD table groups.
- Hono API exposes health, public analytics, internal diagnostics, auth stubs,
  and EventSub webhook entry points with Zod validation.
- Worker implements the modular loop structure with REST discovery, assignment,
  IRC/EventSub adapter boundaries, aggregation, maintenance, and observable
  heartbeats/runs.
- Next.js web app renders the required first pages against API contracts.
- Docker Compose defines caddy, web, api, worker, postgres, migrate, and backup.
- Config is validated through shared Zod schemas.
- Verification commands are run where local tooling permits.

## Current context

The repository currently contains planning docs, ADRs, a glossary, a README,
license, and `.gitignore`. No application code exists yet.

## Constraints

- Do not commit, push, publish, deploy, or call real Twitch APIs with side
  effects.
- Do not store secrets in the repo.
- Do not install global packages or change machine-level configuration.
- `pnpm` is not currently available in the local shell.
- Use Node.js LTS as the target runtime even though the local shell reports
  Node `v24.4.1`.
- Keep Twurple behind project-owned adapter interfaces.

## Risk level

High. The work touches repo structure, package management, database schema,
public API contracts, auth boundaries, worker architecture, and deployment.

## Approval gates

Approval is required before real deployment, production data changes, migrations
against non-local databases, credential handling, package publication, destructive
filesystem operations, broad codemods, or expensive/large agent swarms.

## Mode

Delegated Ultracode mode. Native Codex subagents are available. The parent
session owns scaffold/integration. Subagents are used for bounded read-only
review and planning so the critical path can keep moving.

## Work packets

- `01-prd-surface-review`: read-only review of required surfaces and missing
  implementation risks.
- `02-schema-api-review`: read-only review of database/API shape against the
  PRD.
- `03-scaffold`: parent-owned implementation of repo/package scaffold.
- `04-core-implementation`: parent-owned implementation of schema, API, worker,
  web, and Docker baseline.
- `05-verification`: parent-owned verification and final audit for the current
  implementation increment.

## Eval contract

Full contract: `eval-contract.md`.

## Integration policy

The parent session integrates all files. Agent findings are accepted only when
they cite concrete docs/files or actionable gaps. Write changes remain local to
the parent unless a future packet explicitly assigns disjoint write ownership.

## Verification plan

- Inspect generated file structure.
- Run package-manager/tooling checks when available.
- If dependencies can be installed, run typecheck/build/test scripts.
- If dependencies cannot be installed, run static file checks and record the
  skipped verification honestly.
- Verify Docker Compose, API routes, worker loops, and schema artifacts exist.

## Completion criteria

The full goal is complete only when the current repository proves the requested
end-to-end app exists and relevant checks pass. Partial scaffold progress is not
completion.
