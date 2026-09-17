# Compact membership metadata

Migration 0020 replaces the physical membership table with `membership_event_rows`.
The writable `chat_membership_events` view preserves the original logical columns,
UUIDs, exact timestamps, unresolved identities, nullable values, historical raw
links, and encoded metadata. The Drizzle table mapping targets this compatibility
view; physical indexes and constraints are maintained by the SQL migration.

The common observation timestamp is `received_at`. Small flags distinguish an
identical event or identity-check time, an absent time, and an explicit override.
Creation time remains exact; update time is stored separately only when it differs
from creation time. Source and confidence use NULL physical overrides for their
established defaults, never for missing logical values. JOIN/PART is a physical
boolean. Identity strings and references remain unchanged.

The original SHA-256 deduplication behavior is unchanged. The physical key remains
empty when it can be derived from the event fields; arbitrary keys and NULL remain
verbatim. The unique expression index retains every digest bit. Updating an input
to the derivation, including privacy redaction, preserves the previous logical
digest. No dictionary lookup is needed to compute an indexed value.

Normal INSERT/UPDATE/DELETE operations use the view trigger. Duplicate-tolerant
worker ingestion uses `insert_membership_event`; ON CONFLICT on the outer view
cannot suppress a unique violation raised inside its trigger. The ingestion
function suppresses only the two event uniqueness constraints, leaving foreign
key, metadata, and other failures visible. Historical raw-record references can
still be supplied. Existing privacy deletion and identity resolution operate on
the same logical fields without additional identity caches or dictionaries.

The pending-identity B-tree is retained: a tested BRIN replacement was smaller
but read tens of thousands of extra buffers for this frequent lookup. Time-range
BRINs remain small, with expressions matching the logical view's filters.

## Deployment

1. Stream production into a new isolated PostgreSQL database and retain a pristine
   baseline. Migrate a candidate and compare complete canonical fingerprints with
   `db:verify-storage --layout metadata`.
2. Check aggregation result equality, query plans, total relation size including
   indexes, and backup size. Test concurrent duplicate ingestion, unresolved
   identities, microsecond dates, historical metadata, privacy redaction, and
   ordinary foreign-key failures.
3. Dump and restore the full candidate into a new database, verify it, then apply
   `packages/db/online-migrations/0021_restore_membership_storage.sql` and verify
   again. This rollback requires 0020 to be the latest migration.
4. Guard automatic deployment, retain previous images, build matching application
   images, and stop API/worker/backup writers for the schema transition. Take a
   fresh recovery dump and fingerprint before migration. Allow space for both the
   old and new membership representations plus WAL and backup workspace.
5. Apply migration 0020, verify logical fingerprints, and start matching images.
   Production may use `--membership-only` for both before and after comparisons:
   membership is the only rewritten relation. The full-copy restore rehearsal
   must still compare all relations; the verifier labels the selected scope.
   Check new ingestion, identity resolution, worker loops, endpoints and a fresh
   backup before restoring automatic deployment from main.

The migration rebuilds the membership table and indexes itself; no additional
VACUUM FULL is needed. Other data tables are unchanged. Collection is paused during
cutover, so live IRC observations during that interval can be missed.
