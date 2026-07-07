# Orchestration

## Parent critical path

Create the workflow artifacts, scaffold the monorepo, implement the first
application baseline, and run available verification locally.

## Packets

- `01-prd-surface-review`: read-only agent.
- `02-schema-api-review`: read-only agent.
- `03-scaffold`: parent.
- `04-core-implementation`: parent.
- `05-verification`: parent.

## Delegation

Use two read-only explorer agents in one wave. Do not delegate the immediate
scaffold or integration path.

## Agents

- Agent A: PRD surface coverage and implementation-risk review.
- Agent B: schema/API/worker contract review.

## Delegation limits

One broad read-only wave. Maximum two agents in this run unless the user
approves more.

## Wait points

Do not wait before starting the scaffold. Wait before finalizing the current
increment so agent findings can be integrated.

## Fallback

If agents fail or are unavailable, continue in parent workflow mode and record
the missing review as skipped.

## Verification order

1. Static file existence checks.
2. Package-manager and dependency checks.
3. Typecheck/build/test where possible.
4. Docker Compose config validation if available.
5. Final audit against `eval-contract.md`.
