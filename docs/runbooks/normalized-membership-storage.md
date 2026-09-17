# Normalized membership events

Migration 0020 replaces the physical membership table with `membership_event_rows`
and shared integer references to `membership_event_contexts` (channel and stream)
and `membership_event_identities` (observed login and resolved Twitch user ID).
The writable `chat_membership_events` view preserves the original logical columns,
UUIDs, timestamps, nullable values, historical raw links, and encoded metadata.
The Drizzle table mapping targets this compatibility view; physical indexes and
constraints are maintained by the SQL migration, not that mapping.

The common timestamp is `received_at`. Small flags distinguish an identical event
or identity-check time, an absent time, and an explicit override. Creation time
remains exact; update time is stored separately only when it differs. Source and
confidence use NULL physical overrides for the established defaults, never for
missing logical values. JOIN/PART is a physical boolean. Dictionary rows are
immutable; identity resolution assigns another reference instead of changing
historical observations sharing a dictionary entry.

Event UUIDs remain unchanged. The full SHA-256 deduplication key is stored in the
physical row and unique index. The view exposes the previous empty sentinel when
that key is derivable, retaining the old logical format. Keeping a materialized
digest avoids an indexed function whose result depends on dictionary lookups,
and preserves uniqueness across unusual keys, concurrent ingestion, and privacy
redaction. It limits the net saving: include the digest, every dictionary and all
indexes in comparisons. No digest truncation or probabilistic uniqueness is used.

Normal INSERT/UPDATE/DELETE operations use the view trigger. Duplicate-tolerant
worker ingestion uses `insert_membership_event`; ON CONFLICT on the outer view
cannot suppress a unique violation raised inside its trigger. The ingestion
function suppresses only the two event uniqueness constraints, leaving foreign
key, metadata, and other failures visible. New dictionary entries roll back with
failed insertions. Historical raw-record references can still be supplied.

Privacy deletion first redacts matching events under the existing privacy lock,
then removes matching identity dictionary rows that no longer have references.
The original deduplication key is retained, preventing a replay from restoring a
deleted identity. Direct administrative redactions must perform the same orphan
cleanup; deleting only an event does not erase its shared dictionary entry.

The pending-identity B-tree is retained: a tested BRIN replacement was smaller
but read tens of thousands of extra buffers for this frequent lookup. Time-range
BRINs remain small, with expressions matching the logical view's filters.

## Deployment

1. Stream production into a new isolated PostgreSQL database and retain a pristine
   baseline. Migrate a candidate and compare complete canonical fingerprints with
   `db:verify-storage --layout metadata`.
2. Check aggregation result equality and query plans, not only table heap size.
   Test concurrent duplicate ingestion, unresolved identities, microsecond dates,
   historical metadata, privacy cleanup, and ordinary foreign-key failures.
3. Dump and restore the full candidate into a new database, verify it, then apply
   `packages/db/online-migrations/0021_restore_membership_storage.sql` and verify
   again. This rollback requires 0020 to be the latest migration.
4. Guard automatic deployment, retain previous images, build matching application
   images, and stop API/worker/backup writers for the schema transition. Take a
   fresh recovery dump and fingerprint before migration. Allow space for both the
   old and new membership representations plus WAL and backup workspace.
5. Apply migration 0020, verify logical fingerprints, and start matching images.
   Check new ingestion, identity resolution, worker loops, endpoints and a fresh
   backup before restoring automatic deployment from main.

The migration rebuilds the membership table and indexes itself; no additional
VACUUM FULL is needed. Other data tables are unchanged. Collection is paused during
cutover, so live IRC observations during that interval can be missed.
