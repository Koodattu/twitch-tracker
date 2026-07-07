# Packet 02-schema-api-review: Schema API Review

## Objective

Review the PRD database, API, and worker contracts and identify the minimum
implementation skeleton needed to satisfy the first scaffold increment.

## Context

The parent is creating packages for config, database, Twitch adapters, API,
worker, and web.

## Sources

- `docs/technical-prd.md`
- `docs/architecture-notes.md`

## Ownership

Read-only agent.

## Do

- Inspect schema, API, worker, and Docker sections.
- Return a concise required table/module/route checklist.
- Highlight risky naming or contract choices before implementation hardens.
- Cite file paths and line numbers where possible.

## Do not

- Edit files.
- Run destructive commands.
- Review product/privacy decisions already covered by ADRs unless they affect
  schema/API shape.

## Expected output

Summary, evidence, risks, and recommended parent action.

## Verification

Static document review.

## Handoff format

Use the result schema from the Ultracode packet reference.
