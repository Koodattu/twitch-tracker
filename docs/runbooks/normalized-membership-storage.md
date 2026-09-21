# Normalized membership storage

Migration 0021 stores membership observations in `membership_events`, with integer
references to `membership_event_contexts` and `membership_event_identities`.
Contexts preserve the exact channel/stream pair, including absent streams. Identity
records preserve both the observed login and nullable Twitch ID; historical logins
are never reconstructed from a user's current profile. All original logical fields
remain available through the writable `chat_membership_events` view.

The common event contains its UUID, observation and creation times, compact context
and identity references, JOIN/PART, and deduplication lookup fields. Sparse nullable
columns retain exceptional metadata and historical raw references. Creation times
are distinct in production, so they are preserved rather than silently replaced by
observation time. This is a normalized core with exact metadata, not a claim that
six columns alone can reconstruct every historical field.

## Exact deduplication with compact lookup keys

The unique index stores a signed 64-bit SHA-256 prefix and a collision slot. The
prefix only narrows a lookup: `guard_membership_digest` compares all 256 digest
bits against existing events in that bucket. Different full digests sharing a
prefix receive different slots. Deleting an earlier slot does not hide later
duplicates. Derivable full digests remain omitted from event rows; exceptional
digests and NULL keep their previous meaning.

Concurrent allocation is serialized by the unique bucket/slot index. The writable
view retries slot conflicts under READ COMMITTED and rechecks the complete digest.
A REPEATABLE READ or SERIALIZABLE transaction whose snapshot cannot see the winner
receives SQLSTATE 40001 and must retry its transaction. Ordinary duplicates still
raise a named uniqueness error. The ingestion helper suppresses only genuine
deduplication or event-ID conflicts; a short-prefix collision is never discarded.

Historical UUIDs remain unchanged. New default event IDs use UUIDv7 with a 48-bit
millisecond timestamp and 74 random bits, reducing random primary-index insertion.
They remain opaque public UUIDs and are not authorization credentials. Their layout
follows [RFC 9562 section 5.7](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.7).

## Identity resolution without rewriting complete cohorts

New unresolved observations can share an open identity record for the same login
and observation hour. The resolver takes an exclusive identity lock; insertion
takes a shared lock before referencing it. If every member lies inside the lookup
window, resolution closes the shared record, preserving exact check/update times
without modifying event rows or their indexes. Future inserts cannot reuse a closed
record. Unknown lookups also close their cohort without assigning a user.

Existing historical identities use immutable records. Cohorts crossing the lookup
window are resolved through individual view updates. Ordinary event edits likewise
detach that event from a shared cohort and preserve its logical metadata. This
keeps the existing 24-hour identity boundary and prevents current login owners
from being attached to excluded historical observations.

Privacy redaction continues through the logical view, retaining the previous digest
while removing identity fields. After redaction the API calls
`prune_membership_subject` to remove unreferenced dictionary records for that
subject. Both steps run in the existing privacy transaction and coordination lock.
The physical table has per-table 2% vacuum/analyze scale factors.

## Validation and deployment

1. Stream production into a fresh isolated PostgreSQL container. Retain the dump
   with its checksum and an untouched baseline database.
2. Migrate a separate candidate and compare complete canonical fingerprints for
   all history relations with `db:verify-storage --layout metadata`. Include all
   dictionaries and indexes in storage measurements; compare full dump sizes too.
3. Run integration tests for forced prefix collisions, concurrent duplicates,
   transaction retries, NULLs, metadata exceptions, microseconds, privacy deletion,
   and identity-window boundaries. Check historical reads and aggregation results.
4. Replay the same event stream and identity resolutions against isolated baseline
   and candidate clones. Measure growth over hundreds of thousands of new events,
   including dictionaries and indexes. Compare logical replay fingerprints, excluding
   newly generated UUIDs because the two versions use different UUID generators.
5. Restore the candidate dump into a clean database, compare full fingerprints,
   apply `online-migrations/0022_restore_compact_membership.sql`, and compare again.
6. Coordinate with the VM's shared deployment lock, guard automatic deployment,
   retain old images, and build the exact candidate images. Require exact-head CI.
7. Stop API/worker/backup writers. Take a fresh off-host backup and a membership
   fingerprint. Apply 0021, compare the full logical membership history, then start
   matching images. Check ingestion, all worker loops, public/private endpoints,
   historical reads, privacy tests, and a fresh checksum-verified backup before
   restoring automatic deployment from main.

The reverse migration requires 0021 to be the latest journal entry and writers to
be stopped. It reconstructs the 0020 representation and its original functions and
indexes without changing logical records. Never run old application images against
0021: the new resolver and privacy cleanup are part of this schema transition.

The migration rebuilds membership storage itself. Do not add another VACUUM FULL.
Allow enough free space for both layouts, indexes, WAL, and backup workspace.
Live IRC observations can be missed while collection is paused during cutover.
