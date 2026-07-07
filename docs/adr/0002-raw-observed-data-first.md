# Raw Observed Data First

Status: accepted

During the private MVP, the system stores the fullest practical record of
observed Twitch-derived data before reducing retention and public exposure. This
includes raw chat text, raw ingestion payloads where useful, IRC membership
events, EventSub events, REST snapshots, parsed metadata, and normalized
analytics inputs.

**Considered Options**

- Store only the normalized fields needed for the first public UI.
- Store raw chat text only temporarily for debugging.
- Store raw observed data first, then work backward toward smaller retention and
  stricter public views before production launch.

**Consequences**

The database design must separate raw observed data from long-lived aggregates
so raw tables can be truncated, partitioned, retained for a short period, or
disabled before public deployment. This decision does not include storing OAuth
token values in ordinary analytics tables, collecting data outside official
Twitch interfaces, or bypassing Twitch limits.
