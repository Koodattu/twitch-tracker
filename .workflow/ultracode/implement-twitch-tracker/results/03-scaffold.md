# Result 03-scaffold: Scaffold

## Summary

Created the pnpm TypeScript monorepo scaffold with app/package boundaries,
shared TypeScript config, environment example, structure check script, and
Docker-facing app package manifests.

## Evidence

- Root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`.
- `apps/api`, `apps/worker`, `apps/web`.
- `packages/config`, `packages/db`, `packages/shared`, `packages/twitch`.
- `infra/caddy`, `compose.yaml`, `.env.example`.

## Handoff

Handoff:
- Summary: The repository now has the planned monorepo structure.
- Changed surfaces: package/workspace config, apps, packages, infra.
- Contracts satisfied: monorepo, package, and service layout.
- Assumptions: Corepack-managed pnpm is acceptable on this machine.
- Local checks: `node scripts/check-structure.mjs`.
- Integration evidence: structure check passed.
- Risks: Local Node is v24.4.1 while target runtime is Node 22 LTS.

## Files changed

Multiple root, app, package, and infra files.

## Decisions

Root scripts call `corepack pnpm` because this Windows environment does not
have a standalone `pnpm` shim on PATH.

## Risks

Dockerfiles currently install with `--frozen-lockfile=false` to support the
initial no-lockfile scaffold; tighten this after the lockfile is committed and
stable.

## Verification run

`node scripts/check-structure.mjs` passed.

## Open questions

None for this increment.
