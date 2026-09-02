# Preservation-first storage compaction

Status: accepted

The tracker keeps historical product facts indefinitely unless an explicit
privacy request requires deletion. This includes chat messages, membership
events, viewer observations, stream and channel events, raw EventSub payloads,
raw IRC wire data that is not fully represented elsewhere, and all aggregates.
Age alone is not a reason to remove those records.

Storage is reduced by avoiding repeated representations:

- normalized membership rows replace separate raw `JOIN`/`PART` ledger rows;
- exact IRC wire lines replace a second parsed tag JSON copy;
- viewer samples store descriptive stream metadata only when it changes;
- broadcaster profiles are refreshed daily rather than every discovery poll;
- successful operational runs are sampled hourly while every failure remains;
- successful Helix response bodies are short-lived because their product facts
  are normalized before the payload becomes eligible for redaction.

The three-minute stream-discovery cadence remains because lowering it would
discard viewer observations and can miss short streams. Partitioning is not a
space optimization without a deletion boundary and is therefore deferred.

Local backups are a one-copy recovery cache: a newly validated dump replaces
the prior dump. An off-host copy is still required for disaster recovery, and
the backup service warns while no such copy is attested.

This decision amends ADR 0002 and ADR 0007 where they suggest blanket raw-chat,
raw-EventSub, or viewer-history retention limits. Explicit subject deletion and
security-driven session/token lifecycle remain separate requirements.
