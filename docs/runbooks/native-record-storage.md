# Compact native observation records

Migrations 0024–0028 reduce retained history and future writes without replacing
the native history indexes. They require a coordinated maintenance release of
the database, API and worker. They have been rehearsed locally; production has
not been migrated.

## Representation and application behavior

Canonical decimal external IDs use five or seven binary bytes. Every other
spelling, including leading zeroes, empty strings and Unicode, remains an exact
escaped UTF-8 string. Users and sessions retain their original text primary keys
and gain generated binary keys with unique indexes. Chat, viewer and activity
foreign keys reference those keys. There is no independently retained identity
dictionary to clean up during erasure.

Chat, viewer and raw IRC records keep native observation timestamps and native
ordered indexes. Their creation timestamp uses an exact signed microsecond
offset where possible, with a full timestamp fallback. NULL in the physical
update timestamp means unchanged since creation; later updates are ordinary
native timestamp writes. The public read views reconstruct both timestamps.
Changing an observation timestamp rebases the creation encoding without changing
either logical metadata timestamp. Infinities and dates outside the delta range
are preserved.

Common chat source/type labels and viewer tags use the existing lossless codecs.
Normal inserts, conflict handling and updates to direct view columns remain
native PostgreSQL operations. There are no INSTEAD OF row-write triggers.
Creation and update timestamps are read-only expressions in the Drizzle view
adapter; internal mutations that change update time target the physical records.
The worker's deletion/clear operations and API privacy erasure use that path.
Source links, archived wire-slot clearing, ID-or-login matching and membership
cleanup retain their existing behavior. Public API responses omit generated
parent storage keys.

The logical views are `chat_messages`, `stream_snapshots`, and
`raw_irc_messages`; physical tables are `chat_message_records`,
`stream_snapshot_records`, and `raw_irc_records`. Use physical names for TRUNCATE,
VACUUM, relation-size inspection and internal timestamp writes. Existing indexes
retain their names. These view adapters and codecs use hand-written migrations;
do not replace them with generated table DDL.

## Measured result

The [integrated evidence](../../packages/db/benchmarks/narrow-rows/integrated-results.json)
uses the already retained 20,856 chat, 869 viewer and 8,192 raw observations,
followed by 100,000 synthetic chat/raw records, 50,000 viewer records and 20,000
activity buckets. PostgreSQL 16.14 and Node 24.19.0 were used. Both sides have
freshly rebuilt native indexes; no bloat reclamation is credited. Parent key and
index costs are included. No additional production observations were exported;
the extraction ledger remains 29,917 rows / 25,117,896 bytes.

The [implemented-layout projection](../../packages/db/benchmarks/narrow-rows/integrated-projection.json)
is **0.74 GiB at the recorded production volume**, 1.49 GiB at twice that retained
history, and 2.23 GiB at three times, assuming the same mix and widths. This is an
estimate from bounded, non-random fixtures and estimated production row counts,
not a measured production filesystem reduction. The earlier 1.30–1.33 GiB model
also credited narrower dictionaries, membership packing and additional raw
sentinels that this implementation does not include. None of the rejected block
or posting-page savings are added to this result.

| Local workload | Baseline median | Candidate median |
| --- | ---: | ---: |
| User recent, 51 messages | 0.866 ms | 0.930 ms |
| User offset 10,000, 51 messages | 14.203 ms | 9.220 ms |
| Channel recent, 51 messages | 0.761 ms | 0.806 ms |
| Channel offset 500 | 1.022 ms | 1.023 ms |
| Stream recent | 0.768 ms | 0.804 ms |
| Viewer recent | 0.954 ms | 0.963 ms |
| Viewer offset 300 | 1.204 ms | 1.249 ms |
| Linked erasure, 20,000 messages and raw records | 4.159 s | 4.097 s |
| Insert 1,000 messages | 84.97 ms | 107.70 ms |

History medians use 40 alternating samples after warmup; erasure uses six and
bulk insertion ten. Recent pages incur up to about 0.064 ms median overhead;
this is not a claim of literally zero latency cost. Viewer deep-page p95 was
1.50 → 1.89 ms. Erasure p95 was 4.240 → 4.228 s; WAL varies with full-page images
and does not show the earlier block-layout multiplier. Bulk insertion costs
about 27% more in this fixture, roughly 23 microseconds per message. These local,
warm-cache measurements do not establish production p99 or cold-disk behavior.

All 349 tests passed, including API history/privacy integration and codec edge
cases. Type checking, source lint, application builds, Compose validation and
the migration image build passed. The repository-wide lint command also scans
an existing ignored `.cache/history-blocks-bench/benchmark-v1.mjs` and reports an
unused import there; maintained source was linted with `eslint apps packages
scripts --max-warnings=0`. The [resume rehearsal](../../packages/db/benchmarks/narrow-rows/resume-results.json)
uses the actual CLI, forces a failure at the viewer migration, verifies the
partial checkpoint, resumes, verifies a repeated run is a no-op, then rolls back
and compares every canonical fingerprint again.

The initial dependency audits found seven advisories in Next.js and Sharp.
Release preparation updates Next.js from 16.3.6 to 16.3.8 and resolves Sharp
0.35.5 in the lockfile. Both full and production dependency audits now pass with
no known vulnerabilities; the existing ESLint plugin patch is unchanged.

## Production preflight and release

The read-only production check on 2026-10-10 found 14,080,031,767 database bytes,
6,729,580,544 bytes free on the Docker filesystem (92% used), and approximately
302 MB allocated to WAL. Chat alone occupies 4,352,196,608 bytes. Docker reports
about 1.8 GB reclaimable build cache; that alone did not provide a comfortable
rollback reserve. That initial check made no production changes.

Later on 2026-10-10, the existing backup cache was moved to the attached 30 GiB
ext4 volume at `/mnt/HC_Volume_107097089/twitch-tracker`. The archive SHA-256,
catalog, metadata and ownership were verified before removing the duplicate
from `/srv/backups/twitch-tracker`, reclaiming 3,733,776,584 root-disk bytes.
`BACKUP_HOST_PATH` now points to the new directory. The backup service is healthy
and retains its existing schedule; API, worker and PostgreSQL containers were
unchanged during the move. The final check found 12,500,488,192 bytes (11.64 GiB)
available on the root disk and 26,165,182,464 bytes (24.37 GiB) on the volume.
The persistent volume mount was verified. On 2026-10-10, the operator explicitly
authorized this production compaction release with the attached-volume recovery
copy and no off-host backup. This is the accepted recovery exception for this
release; do not treat off-host confirmation as a remaining approval gate and do
not set `BACKUP_OFF_HOST_CONFIRMED=true`. Validate a fresh attached-volume backup
before the schema changes.
The operation record is `/var/lib/twitch-backup-volume-20261010-2/result.json`
on the VM. The database schema has not been upgraded by this relocation.

Reserve **at least 10 GiB free before starting**, plus any concurrent backup
space, and reassess using current relation/WAL sizes. Forward migration commits
one table at a time, but the provided rollback scripts expand several relations
per transaction. Recheck free space with the deployment lock held: automatic
builds consumed roughly 2 GiB during the audit. Avoid starting a migration merely
because its final format is smaller.

1. Finish the normal release review/CI and build immutable matching images.
   Coordinate the existing auto-deployer so it cannot run the standard migrator
   independently. Retain the previous images and confirm a validated recovery
   point through the existing backup lifecycle. Do not download a production
   database copy for this rehearsal.
2. Establish disk/WAL headroom and a maintenance window. Stop API and worker
   writers. Live IRC observations during this pause can be missed; retained
   observations remain intact. Keep the application stopped at partial
   checkpoints.
3. Using the **new** migration image, capture the canonical baseline with writes
   stopped. The verifier now includes activity buckets and parent rows and
   understands each migration checkpoint. Capture a fresh baseline; older
   reports omit those tables.

   The verifier reads raw observations in 25,000-row keyset batches and expands
   only their referenced archive slots. This preserves the original canonical
   fingerprints without materializing the entire uncompressed archive on disk.
   A 2 GiB temporary-file limit bounds each verifier backend. The production
   rehearsal exposed excessive temporary disk use in the earlier whole-archive
   scan; it was cancelled before any schema changes. The bounded replacement
   matched the original on 50,005 synthetic rows across timestamp ties and
   microseconds, and rejected a corrupted source-attribution cache.

   ```sh
   docker compose --env-file .env.production run --rm --no-deps migrate \
     node dist/verify-storage.js --database twitch_tracker --layout compact > storage-before.json
   docker compose --env-file .env.production run --rm --no-deps migrate \
     node dist/migrate-record-storage.js --database twitch_tracker
   ```

   Replace `twitch_tracker` with the exact configured database name. Do not print
   credentials or environment-file contents.

4. Run the checkpointed upgrade and monitor filesystem space throughout:

   ```sh
   docker compose --env-file .env.production run --rm --no-deps migrate \
     node dist/migrate-record-storage.js --database twitch_tracker --apply
   ```

   It validates migration checksums and expected versions, takes an advisory
   lock, and commits each migration and journal entry together. 0024 installs
   codecs/parent keys; 0025 rewrites chat once; 0026 rewrites viewers once; 0027
   rewrites raw metadata once; 0028 rewrites activity keys. On failure, the
   current phase rolls back. The same command resumes from the last committed
   checkpoint. It does not automatically stop services or provision disk.
   Fresh empty databases can use the normal `db:migrate`; existing production
   upgrades must use this runner to avoid retaining all old heaps in one
   transaction. Successful type rewrites reclaim the old heap/index files on
   commit; a second VACUUM FULL is unnecessary.
5. Capture an after report and compare its `fingerprints` with the baseline (or
   mount the baseline read-only and use the verifier's `--compare` argument).
   Require exact matches for every table. Then start the matching API and worker
   and check ingestion, recent/deep histories, viewer pages, aggregation,
   community reads, privacy erasure and backup health. Record actual relation
   and filesystem savings separately from the projection. Restore normal
   deployment operation only after the release checks pass.

## Rollback

Keep writers stopped. From a fully migrated 0028 database with no later
migrations, execute `packages/db/online-migrations/0025_restore_native_records.sql`
and then `packages/db/online-migrations/0024_restore_external_keys.sql` using
psql with `ON_ERROR_STOP=1`. Both scripts check their expected journal state,
restore exact logical values, and remove only this package's migration entries.
They are a pair: do not start either application version between them. If the
forward upgrade stopped at a partial checkpoint, resume it before using these
full-package rollback scripts. Retain adequate expansion/WAL headroom.
Compare canonical fingerprints again before restarting the previous images.

## Reproduction

Use the task-owned PostgreSQL 16.14 fixture on loopback port 55438. Create empty
`storage_baseline_test` and `storage_candidate_test` databases, then run
`node packages/db/benchmarks/narrow-rows/integrated.mjs` followed by
`node packages/db/benchmarks/narrow-rows/integrated-projection.mjs`. The benchmark
rejects existing tables and uses only the hash-checked saved local inputs.
Create `storage_resume_test` from the **local synthetic** baseline fixture, build
the DB package, and run `node packages/db/benchmarks/narrow-rows/resume.mjs`.
Results contain only aggregate evidence, timings and sanitized plan nodes.
