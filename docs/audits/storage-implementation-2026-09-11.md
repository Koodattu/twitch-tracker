# Storage implementation and validation — 2026-09-11

The implemented changes reduce the restored Twitch Tracker database from
**7.822 GB to 6.768 GB**, a **1.054 GB / 13.5%** reduction, while preserving
the historical contents of the changed tables. These are decimal GB and include
table, TOAST, and index storage. Production has not been migrated.

The baseline is a complete, freshly restored production dump, not the larger
live database from the [initial audit](storage-audit-2026-09-11.md). This keeps
ordinary heap/index rebuilding out of the claimed structural savings. The local
candidate uses the same pinned PostgreSQL 16.14 image as production.

## Measured storage

| Relation group | Restored baseline | Final candidate | Saved |
| --- | ---: | ---: | ---: |
| Raw IRC, including the new payload-block table | 2,772.9 MB | 1,915.4 MB | 857.5 MB / 30.9% |
| Chat messages | 1,683.3 MB | 1,546.4 MB | 136.8 MB / 8.1% |
| Membership events | 1,193.8 MB | 1,133.8 MB | 60.0 MB / 5.0% |
| Entire database | 7,822.2 MB | 6,767.9 MB | 1,054.3 MB / 13.5% |

The entire-database comparison also includes other relations and catalog space,
so it is not exactly the sum of the three table deltas. Raw storage includes
stable metadata rows, block payloads, TOAST indexes, the existing indexes, and
the new partial index used to find unpacked rows.

The largest remaining groups are raw IRC (1.915 GB), chat (1.546 GB), membership
(1.134 GB), raw Helix responses (650 MB), chatter/channel activity buckets
(445 MB), and viewer snapshots (441 MB). Compression does not remove the cost
of normalized messages, provenance, stable identities, or useful indexes.

## Implemented design

- **Lossless raw IRC blocks.** Keep every raw row's ID, metadata, timestamps,
  and foreign-key references. Move older wire lines into native PostgreSQL
  arrays of at most 256 records with PGLZ compression. Publish block locators
  transactionally after checking stored array equality. Recent lines stay inline.
- **Reads and privacy.** Bulk diagnostics expand each required block once.
  Single-row SQL has a fail-closed accessor. The existing privacy update/delete
  path clears archived slots transactionally, including explicit empty-string
  replacement. Other records in the block remain intact. PostgreSQL dead-version,
  WAL, vacuum, and backup lifecycle rules still apply.
- **Compact, opaque identifiers.** Canonical lowercase UUID-shaped message IDs
  use 17 bytes, including a format marker. Other strings retain their exact UTF-8
  representation with a different marker. Application IDs remain strings.
  Canonical-encoding constraints prevent alternate binary representations from
  bypassing deduplication. Membership digests retain all 256 bits in 32 bytes.
- **Stop aggregate churn.** Calculate message and membership bounds together and
  exclude unchanged chatter/channel buckets before the insert. Keep the conflict
  check for races. Regression checks compare both physical tuple identities and
  row-lock metadata across committed reruns, and cover corrections and late arrivals.
- **Bounded ongoing compaction.** Maintenance packs at most 2,560 rows older than
  one day after existing housekeeping. The explicit backfill command commits
  every 5,120 rows, resumes after interruption, and reports locked rows remaining.
  No retention windows or sampling rates were shortened.
- **Backup failure handling.** Failed attempts mark health unhealthy immediately
  and retry within five minutes. A new successful backup clears that marker.
  Existing known-good retention protection remains in place.
- **Repeatable verification.** CI now runs PostgreSQL integration tests against
  the pinned image. The migration image includes compaction and canonical
  verification CLIs. The local production-copy directory is excluded from Docker
  build contexts as well as Git.

## Decisions from full-copy testing

A 680-block sample suggested LZ4 would save another 9% of payload bytes. The
complete LZ4 block table instead occupied **889.7 MB**, versus **842.6 MB** for
the PGLZ working candidate, including TOAST and indexes. The final format therefore
uses PGLZ. A promising sample was not treated as a measured full-database saving.
The final restored PGLZ block table occupies 832.5 MB.

The first raw diagnostic implementation decompressed a block for every returned
row. A 1,000-line query took about 232 ms versus 6 ms inline. Batched expansion
reduced that cost substantially while preserving exact query results. Raw
diagnostics still have a decompression cost; ordinary chat reads do not read
the block archive. Local Windows-backed timings are not production latency or
downtime guarantees.

The final idle comparison used five busy streams, up to 1,000 rows per query,
and 15 warm runs per case. Results matched exactly in both layouts:

| Query | Baseline median | Compact median |
| --- | ---: | ---: |
| Raw diagnostics | 5.24 ms | 26.22 ms |
| Normal chat history | 30.47 ms | 30.51 ms |

Raw diagnostics are about five times slower in this local measurement, though
the absolute difference is about 21 ms. This cost should be monitored after
deployment; normal chat latency was essentially unchanged in this check.

Full-copy testing exposed a second source of write work: `ON CONFLICT DO UPDATE`
can lock an existing row even when its `WHERE` condition skips the update.
See [PostgreSQL INSERT](https://www.postgresql.org/docs/16/sql-insert.html).
The earlier combined query exceeded a 90-second local limit, including after
statistics refresh. Its read/aggregate phase took 26.8 seconds, with most of that
spent reading data; it produced roughly 409,000 buckets.

Filtering unchanged buckets before the insert reduced the full 48-hour check
to **51.5 seconds with 1,832 changed buckets**, followed by **40.4 seconds and
zero changed rows** on identical input. The check used the same 90-second limit
and rolled back its changes. A regression reproduced changed row-lock metadata
without this filter and passed with it. Other rollup tables retain their existing
conflict guards; this change addresses the largest chatter/channel pass.

No currently useful indexes were removed. The production copy contains older
online index additions/removals and `pgcrypto` that a migrations-only fresh
database lacks. Schema comparison verified that these known earlier differences
are separate from the new table definitions, functions, constraints, triggers,
and partial unpacked index, which match the final migration files.

## Preservation evidence

Every canonical row in these tables matched the untouched restored baseline:

| Table | Rows checked |
| --- | ---: |
| Raw IRC | 5,563,830 |
| Chat messages | 3,437,196 |
| Membership events | 3,464,875 |
| Viewer observations | 1,749,466 |

The comparison includes all original columns, decoded identifiers, exact wire
text, and original timestamp precision. It uses row counts and two aggregate
halves of full-row MD5 hashes; this is an accidental-change check, not a proof
against deliberately constructed hash collisions. The reusable verifier also
checks archived locators and source-attribution cache values.

The rollback fixture retains an opaque ID, an uppercase parent ID, all digest
bytes, an exact wire line, and a microsecond timestamp through packing, rollback,
and reapplication of the final migrations. The verification CLI accepts the
matching baseline and rejects an intentionally altered one.

The final custom-format backup transferred **2,051,058,067 bytes** and restored
successfully with both `pg_dump` and `pg_restore` exiting zero. The restored
database measured 6.768 GB; the working candidate before performance probes
measured 6.780 GB. The main table compares freshly restored databases on both
sides. After the final NULL batch-size guard was applied,
the restored schema matched the candidate. Canonical verification on the restored
database returned `matchesBaseline: true` for all four tables, with zero raw
locator or source-cache errors.
The archive was streamed directly into the restore; no separate dump file was retained.

Verification also passed:

- All **179 tests in 31 files**, including packed-data privacy deletion, mixed
  inline/packed bulk reads, missing-slot failures, opaque IDs, dedupe, rollback,
  locked-row skipping, and invalid/NULL batch sizes.
- Workspace type checking and builds; ESLint with zero warnings; structure and
  diff checks; compose configuration; backup-shell syntax, retention, and retry tests.
- Fresh migration fixtures, rollback/reapplication, and schema comparisons that
  account for the documented earlier online index changes.

Running tests concurrently with the full restore caused API hook/test timeouts
and overlapping fixture operations. A later idle run also hit a database-reset
hook timeout on the Windows bind mount. Moving the small synthetic test database
onto dedicated native Docker storage resolved this: the final run passed all
179 tests in 104 seconds, with no timeout or assertion changes. Fresh final
migrations were applied to that database before testing.

The large production copies use a Windows bind mount because Docker's managed
disk lacked space for them. Local index-build memory was increased from 64 MB to
256 MB; production settings were not changed. These environment details limit
what the local timings say about production.

## Retained local review environment

- Container `twitch-storage-audit-20260911`, PostgreSQL on `127.0.0.1:55434`:
  `twitch_tracker_copy` is the untouched baseline; `twitch_tracker_candidate`
  is the verified restored compact database. The superseded experimental copy
  was removed after verification and the restored copy took its name.
- Container `twitch-storage-tests-01a090a8`, PostgreSQL on `127.0.0.1:55435`:
  `twitch_tracker_test` is the isolated synthetic integration-test database.
- Local connection settings and aggregate measurement files are under ignored
  `.cache/storage-audit/`; `client.env` contains generated local credentials and
  must stay private. No production wire data or credentials were added to Git.

## Production rollout and remaining work

Follow the [rollout and rollback runbook](../runbooks/storage-compaction-rollout.md).
The identifier changes rewrite tables and indexes; old application code cannot
write the new format. Coordinate the existing automatic deployment mechanism,
obtain a fresh restore-tested recovery copy, stop writes for migration, then
start the matching release. The separate raw `VACUUM FULL` step also requires
a planned lock window. Stopping IRC ingestion can miss live events.

The latest read-only VM check showed **87% filesystem usage and 10.315 GB
available**. Allow for replacement relations, WAL, temporary files, backup
overlap, and other applications' growth. Saving about 1 GB in this database does
not by itself resolve shared-host capacity. Production has not been changed,
and no commit or push has been made.

The following opportunities remain deliberately separate:

- Lean viewer rows could save tens of MB, but require preserving source links,
  stable pagination, and metadata transitions. Their benefit is smaller than
  the implemented raw-storage changes.
- Shortening Helix retention is not justified by the current normalization state:
  HTTP success does not prove all historical facts have been preserved elsewhere.
  The existing 30-day policy remains unchanged.
- Smaller telemetry/header/empty-JSON representations offer additional savings,
  but do not justify unrelated rewrites in this release.
- Columnar or external compressed archives may compress further, but need a
  separate design for point reads, updates, restoration, and privacy erasure.
