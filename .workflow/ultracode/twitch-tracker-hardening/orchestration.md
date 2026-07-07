# Orchestration

## Parent critical path
Inspect current auth/config/worker paths, patch scoped fixes, update docs, verify.

## Packets
- 01-config-api: parent-owned.
- 02-worker-ingestion: parent-owned.
- 03-web-docs: parent-owned.

## Delegation
No native subagents used.

## Agents
None.

## Delegation limits
Native subagents are available, but the user did not explicitly request subagents or parallel delegation in the active request.

## Wait points
None.

## Fallback
Execute all packets in the parent session with concise notes.

## Verification order
Typecheck, build, structure check, then final source review.
