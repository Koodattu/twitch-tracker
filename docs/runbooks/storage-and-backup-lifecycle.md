# Storage and backup lifecycle

This runbook covers storage reporting, bounded local backup retention, off-host
replication requirements, and the approval gates for database cleanup. It does
not authorize deleting or rewriting production data.

## Backup invariants

The backup service creates a PostgreSQL custom-format archive with explicit
`gzip:6` compression by default. It validates the archive catalog, creates a
SHA-256 sidecar, publishes the completed pair, and updates `.last-success`
before pruning anything.

Local retention is the intersection of three limits:

- `BACKUP_RETENTION_DAYS`: keep complete backups whose age is at most this many
  exact 24-hour periods. A backup becomes eligible when its age is greater than
  `days * 86400`; this avoids `find -mtime` rounding surprises.
- `BACKUP_MAX_COUNT`: keep at most this many complete backup pairs, newest first.
- `BACKUP_MAX_TOTAL_BYTES`: keep the newest contiguous set of complete dumps
  whose dump bytes fit this cap.

The `.last-success` backup is always preserved, even when it alone exceeds a
cap. If the marker is missing, malformed, or points to a missing dump/checksum
pair, pruning fails without deleting anything. Incomplete dumps without a
checksum are reported and ignored. Pruning runs only after a new dump has
passed catalog validation and has been published.

The production defaults retain exactly one local recovery dump, cap its
directory at 10 GiB, reserve
5 GiB before starting a new dump, warn at 80% filesystem usage, and report
unhealthy at 90%. A newly created dump is validated and marked successful
before the preceding dump is removed, so normal rotation never intentionally
leaves zero recovery copies. These are safety ceilings for the local recovery
cache, not a disaster-recovery retention policy.

`BACKUP_OFF_HOST_CONFIRMED=true` is an operator attestation. When it is false,
backup creation continues but emits a warning. Set it to true only after
`BACKUP_HOST_PATH` is verified as a remote mount or as a directory copied by an
independently monitored replication job. A directory on the application VM's
root filesystem does not qualify.

## Pre-deployment checks

1. Confirm `BACKUP_HOST_PATH` and its filesystem with `findmnt -T`.
2. Confirm the remote or replicated destination has independent capacity,
   retention, access controls, and encryption.
3. Confirm the replication process copies only published `.dump` and matching
   `.sha256` files. Temporary dotfiles are incomplete and must not be copied.
4. Verify the remote checksum after transfer. Keep remote deletion independent
   of local pruning until restore drills are passing.
5. Record the recovery owner, daily recovery-point objective, restore-time
   objective, remote retention, alert destination, and restore-drill schedule.

Do not deploy a new local cap as the only copy of older recovery points. Copy
and verify the backups that must survive the cap first.

## Status and dry-run retention

The health check reports complete backup count/bytes, free bytes, filesystem
usage, marker target, and marker age without reading database payloads. Run the
same inventory manually:

```sh
docker compose --env-file .env.production exec backup \
  /bin/sh /opt/twitch-tracker-backup/backup-health.sh
```

Preview retention selection without deleting files:

```sh
docker compose --env-file .env.production exec \
  -e BACKUP_RETENTION_DRY_RUN=true \
  backup /bin/sh /opt/twitch-tracker-backup/backup-retention.sh
```

Review every selected filename and reason. Run the command without the dry-run
override only after off-host copies and checksums have been verified. Normal
backup execution applies the same retention logic after each successful dump.

## Database storage report

Run the metadata and aggregate-only report during a normal-load period:

```sh
docker compose --env-file .env.production exec -T postgres \
  sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < infra/postgres/storage-report.sql
```

The report starts a read-only transaction and sets statement and lock timeouts.
Its daily-rate section reads high-volume tables, so do not schedule it every
minute. Store successive outputs in the operations system to measure relation,
index, TOAST, row-count, WAL, and temporary-I/O deltas over time.

## Data lifecycle

Age alone is not a deletion criterion. The production policy keeps normalized
facts, messages, membership history, raw IRC wire data, raw EventSub payloads,
viewer observations, and aggregates indefinitely, subject only to explicit
privacy deletion requests. The maintenance loop does not redact those classes.

The one bounded class is successful Twitch Helix response bodies. The same
facts are normalized into users, channels, sessions, snapshots, presence, and
rate-limit observations before use. `RAW_PAYLOAD_RETENTION_DAYS` controls when
the duplicated request/response body is cleared while the thin request ledger
row remains. Failures should remain diagnosable from status and operational
records. Do not reuse this setting for chat or EventSub data.

Future writes avoid redundancy without lowering observation frequency:

- IRC `JOIN` and `PART` wire lines are represented by durable membership rows
  and are not also inserted into the raw IRC ledger.
- Other raw IRC rows keep the exact wire line, but do not duplicate its IRCv3
  tags in a parsed JSON column.
- Every viewer sample remains in `stream_snapshots`; descriptive metadata is
  stored only on the first sample and when it changes. API reads carry the last
  observed metadata forward.
- Full broadcaster profiles refresh at most daily unless another path updates
  them, instead of once per three-minute discovery poll.
- All failed ingestion runs are stored. Successful runs are sampled hourly with
  the number of represented successes in the summary; current status and the
  latest complete summary remain in `worker_heartbeats`.
- Permanent IRC assignment failures are remembered per bot and broadcaster so
  the scheduler does not retry a known ban every 30 seconds.

Keep the three-minute discovery interval unless the product explicitly accepts
missing short streams and coarser viewer series. The five-minute aggregate size
does not make the underlying three-minute observations redundant.

## Existing-data compaction

Do not delete history by timestamp. Existing redundancy can be compacted in a
separate, measured maintenance operation after a verified restore point exists:

1. Apply `packages/db/online-migrations/0010_storage_index_cleanup.sql` outside
   a transaction. It removes five indexes with no repository query consumers
   while retaining all primary, unique, time, stream, and chatter indexes.
2. Verify raw IRC lines can be reparsed, then clear legacy parsed tag JSON in
   bounded batches. The exact wire line remains authoritative.
3. Rewrite legacy snapshot rows so only actual metadata versions retain the
   repeated descriptive columns. Preserve every timestamp and viewer count.
4. Re-encode legacy membership dedupe values as fixed-size hashes only after a
   collision/uniqueness check. The meaningful source columns remain unchanged.
5. Run ordinary `VACUUM (ANALYZE)` and verify APIs, worker health, row counts,
   min/max timestamps, and a new backup. This makes dead pages reusable but may
   not return them to the host filesystem.
6. Use an online rewrite tool such as `pg_repack`, or a planned copy/swap, only
   if returning physical bytes to the filesystem is necessary. `VACUUM FULL`
   takes an exclusive table lock and is not appropriate during live IRC ingest.

Each transformation needs before/after counts and semantic validation. A
normal application rollback cannot reconstruct removed redundant encodings, so
do not compact the legacy rows merely because the new write path is deployed.
