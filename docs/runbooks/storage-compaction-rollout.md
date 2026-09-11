# Storage compaction rollout

Migrations 0015 and 0016 retain historical observations and source evidence.
They require a coordinated maintenance deployment, not an unattended push to
the auto-deploy branch. The identifier changes rewrite tables and indexes.

## Storage format

`raw_irc_messages` remains the durable identity/metadata table and all existing
foreign keys remain valid. Recent wire lines are inline. Older lines are packed
into PostgreSQL `text[]` blocks of at most 256 records, compressed by native
TOAST PGLZ. Full-copy measurements selected PGLZ over LZ4 for this dataset.
See [PostgreSQL column compression](https://www.postgresql.org/docs/16/sql-createtable.html).
Packed rows have an empty inline `raw_line` and a block/position locator. An
empty inline column alone is not evidence of a missing or redacted message.

Read the wire line with:

```sql
SELECT read_raw_irc_line(raw_line, payload_block_id, payload_position)
FROM raw_irc_messages
WHERE id = '<raw UUID>';
```

Single-row SQL reads can use `rawIrcLineSql`; the API's bulk diagnostics use
`readRawIrcLines` to expand each required block once. The community input query uses a cached
source-attribution predicate so it does not decompress history during graph
building. Block publication is transactional: the function locks source rows,
verifies the complete stored array against the original lines, then publishes
locators in the same transaction. Do not hand-edit locators or block arrays.

Updating a packed row's `raw_line` restores it inline and removes its previous
block slot in the same transaction. Deleting a raw row also clears its slot.
This preserves the existing privacy deletion path; replacing an inline value
cannot leave its old text in an archived block. Empty block shells may remain
after deletion, but their slots contain no original text. Normal PostgreSQL
dead-version/vacuum and backup lifecycle rules still apply. Do not use TRUNCATE
as a production deletion workflow: it does not invoke row deletion triggers.

Chat message/reply identifiers use a reversible binary encoding. A canonical
lowercase UUID uses a one-byte format marker plus its 16 bytes; all other strings
use a different marker plus their exact UTF-8 encoding. External IDs remain
opaque strings in the application. `encode_chat_message_id(text)` and
`decode_chat_message_id(bytea)` provide the same conversion for SQL clients.
SQL inserts/comparisons on these columns must encode string parameters; Drizzle
does this automatically. UUID-shaped values, uppercase values, arbitrary strings,
empty strings, and null reply IDs retain their distinct meanings.

Membership dedupe keys store all 32 SHA-256 digest bytes. The application still
uses canonical base64url strings. No digest is shortened and uniqueness remains
enforced. To read a digest through SQL:

```sql
SELECT translate(rtrim(encode(dedupe_key, 'base64'), '='), '+/', '-_')
FROM chat_membership_events;
```

## Before deployment

1. Check current filesystem capacity and a successful, fresh recovery copy.
   Restore-test it, and run `ANALYZE` on restored copies before query benchmarks.
   Account for replacement tables/indexes, generated WAL,
   temporary work, and overlap with backup creation; current database size alone
   is not the needed free-space allowance. Local Windows-backed test timings
   are not a production downtime estimate.
2. Coordinate the server's existing auto-deployment mechanism so it cannot
   start this migration independently of the maintenance window. Do not disable
   unrelated services or clean unrelated Docker volumes.
3. Build the complete release before stopping ingestion. Stop API and worker
   writes, and stop requests that hold long read transactions. Stopping
   IRC ingestion can miss live events; obtain an agreed window or implement an
   independent durable capture buffer if uninterrupted capture is required.
4. Run the normal migration image against the intended database. Both migrations
   use a five-second lock timeout, so lock contention fails rather than waiting
   indefinitely. Investigate the blocker; do not remove the timeout blindly.
   Refresh planner statistics on the rewritten tables with
   `ANALYZE chat_messages; ANALYZE chat_membership_events;`.
5. Start the matching API and worker version. Verify ingestion, dedupe, raw
   diagnostics, community source attribution, privacy deletion, and backup health.

The maintenance loop packs at most 2,560 rows per run, only older than one day.
At the default five-minute interval, this caps throughput at 737,280 rows/day;
watch the eligible backlog if capture volume approaches that rate.
This provides bounded ongoing compaction without changing ingestion cadence or
deleting history. For gradual rollout, leave physical files allocated for reuse
and measure before scheduling a rewrite.

## Full historical backfill

Capture a canonical baseline before migrations, with writes stopped or from a
consistent restored copy. The verification CLI prints only aggregate fingerprints
and sizes; it never prints wire lines or user records:

```sh
node dist/verify-storage.js --database twitch_tracker --layout inline > baseline.json
# After migration and compaction, against the matching snapshot:
node dist/verify-storage.js --database twitch_tracker --compare baseline.json > compact.json
```

Run it through the DB package or migration image with `DATABASE_URL` set. It uses
a read-only repeatable-read transaction, checks all three changed tables plus
viewer observations, and validates raw locators and cached source attribution.
The fingerprints combine full canonical JSON row hashes and counts, independent
of row order. They detect accidental data changes; they are not a cryptographic
proof against deliberately constructed collisions. Timestamp rendering uses UTC.
Full scans can take minutes and use temporary disk; run on an isolated copy or
within the planned verification window. Live ingestion between snapshots will
correctly produce a mismatch.

The CLI defaults to a read-only eligibility report. It requires the exact
database name and reads credentials from `DATABASE_URL` without printing them.
Build the DB package first when running from a checkout:

```sh
pnpm --filter @twitch-tracker/db build
pnpm --filter @twitch-tracker/db db:compact --database twitch_tracker --before '<UTC cutoff>'
pnpm --filter @twitch-tracker/db db:compact --database twitch_tracker --before '<same UTC cutoff>' --apply
```

The migration image also contains the compiled CLI at `/app/dist/compact-storage.js`:

```sh
docker compose --env-file .env.production run --rm --no-deps migrate \
  node dist/compact-storage.js --database twitch_tracker --before '<UTC cutoff>' --apply
```

Every transaction is bounded to 5,120 rows and commits independently. Interruptions
roll back only the active batch; rerun with the same cutoff to resume. Locked rows
are skipped during a batch, and the CLI fails with an explicit remaining-row
message if it cannot finish the requested cutoff. Existing IDs, raw metadata,
timestamps, messages, membership facts and viewer observations are unchanged.

Compaction updates do not promise smaller operating-system files immediately.
After validation and with sufficient space, a separate maintenance window can
reclaim old raw pages and rebuild its indexes:

```sql
VACUUM (FULL, ANALYZE) raw_irc_messages;
VACUUM (ANALYZE) raw_irc_payload_blocks;
```

`VACUUM FULL` blocks readers and writers of the affected table. Do not run it
casually during live ingestion. Compare `pg_total_relation_size` of the raw
table **plus** the payload-block table against the original total, including
the partial unpacked index. Compare identifiers against a restored baseline to
separate structural savings from ordinary index/heap rebuilding.

## Rollback

Do not deploy older application code against compact columns. With writers
stopped and a fresh recovery copy available, run
`packages/db/online-migrations/0017_restore_inline_storage.sql` through psql.
It restores inline lines, decodes message IDs and digests, removes the new
storage objects, and removes only the two corresponding migration entries.
It refuses to proceed if later migrations exist. Allow extra disk for expansion,
replacement indexes and WAL; returning to the old format is itself a rewrite.

Verify counts and canonical data fingerprints before starting the old release.
If the rollback cannot complete, the transaction rolls back and the compact
schema remains usable by the new release. Keep the new release available until
rollback and verification have both succeeded.

The archive has no external codec dependency: PostgreSQL dump/restore includes
the blocks, locators, functions, triggers, constraints, and binary identifiers.
Recovery verification must cover decoded contents and application queries, not
only the dump's catalog.
