# One Modular Worker Service

Status: accepted

The MVP uses one worker container with modular internal loops for discovery,
user hydration, chat assignment, IRC ingestion, EventSub reconciliation,
aggregation, and maintenance. The deployment stays simple while the code remains
split by responsibility.

**Consequences**

Each loop should have its own heartbeat, persisted ingestion runs, timeouts,
retry behavior, and error reporting. A recoverable failure in one loop should
not unnecessarily stop unrelated loops, but unrecoverable configuration or
database failures should stop the process. The architecture can split into
multiple worker services later if measured load or operational isolation
requires it.
