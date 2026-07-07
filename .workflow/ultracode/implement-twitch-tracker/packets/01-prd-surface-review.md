# Packet 01-prd-surface-review: PRD Surface Review

## Objective

Review the technical PRD and ADRs and identify implementation surfaces that the
parent scaffold must not miss.

## Context

The parent is implementing the first end-to-end scaffold locally.

## Sources

- `docs/technical-prd.md`
- `docs/adr/`
- `CONTEXT.md`

## Ownership

Read-only agent.

## Do

- Inspect the PRD and ADRs.
- Return a concise checklist of must-have implementation surfaces.
- Highlight contradictions or scope traps.
- Cite file paths and line numbers where possible.

## Do not

- Edit files.
- Run destructive commands.
- Duplicate the schema/API packet.

## Expected output

Summary, evidence, risks, and recommended parent action.

## Verification

Static document review.

## Handoff format

Use the result schema from the Ultracode packet reference.
