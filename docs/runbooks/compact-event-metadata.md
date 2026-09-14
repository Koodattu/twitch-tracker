# Compact event metadata

Migration 0017 changes physical representations without changing application
values. Deploy it with matching API and worker code during coordinated
maintenance; the VM's automatic deployment must not run it independently.

## Encodings

`chat_messages.badges`, `chat_messages.emotes`, and `raw_irc_messages.tags`
use `bytea`. The first byte selects the representation:

| Marker | Payload |
| --- | --- |
| 0 | Empty JSON object, no additional bytes |
| 1 | UTF-8 string for the sole `raw` property |
| 2 | UTF-8 JSON for every other shape not covered below |
| 3 | String-valued badge map; repeated key-code, one-byte UTF-8 length, value bytes |

Marker 3's key codes are fixed by migration 0017 and `compact-metadata.ts`.
Unknown keys, non-string values, and values exceeding 255 UTF-8 bytes use the
general JSON representation. No hash replaces metadata and no badge version,
emote position, unusual JSON field, or numeric value is discarded. PostgreSQL
encodes historical JSON directly, preserving precision beyond JavaScript's
number range. SQL decoders and constraints validate stored representations.

`chat_membership_events.source` and `raw_irc_messages.parsed_command` remain
physical text columns. An empty physical string represents `irc_membership`
and `PRIVMSG`, respectively. Every other value is prefixed with `!`, including
an original empty string or a string already beginning with `!`. NULL commands
remain NULL. This supports future source/command names without enum changes.

Drizzle reads and writes the original JSON objects and strings. Direct SQL must
explicitly encode writes and decode reads:

```sql
SELECT decode_compact_json(badges), decode_compact_json(emotes)
FROM chat_messages LIMIT 1;

SELECT decode_common_label(source, 'irc_membership')
FROM chat_membership_events LIMIT 1;

SELECT decode_compact_json(tags), decode_common_label(parsed_command, 'PRIVMSG')
FROM raw_irc_messages LIMIT 1;
```

Privacy deletion writes encoded empty objects and retains the existing raw
payload-slot deletion triggers. Timestamps, IDs, dedupe digests, event ordering,
raw wire lines, moderation fields, and all indexes retain their meanings.

## Verification and rollout

1. Stream a consistent production dump into an isolated database and preserve
   the original dump. Clone it for migration tests. Never run destructive
   integration fixtures on the real-data copy.
2. Build the DB package and run `verify-storage.js --database <exact-name>
   --layout metadata` before migration. This fingerprints complete rows of the
   three event tables, viewer observations, and every complete raw payload
   block. It preserves block IDs and locators in the comparison and avoids
   expanding each packed line into a separate joined row.
3. Run normal migrations on the candidate, then repeat verification with
   `--compare <baseline.json>`. Compare against a fresh-restored baseline to
   separate format savings from ordinary index rebuilding. Run application,
   privacy, ingestion, rollback, and full dump/restore checks.
4. Guard the production checkout against unattended main-branch deployment,
   wait for CI, and build the exact release before stopping writers. Keep the
   previous application images and sufficient disk for the table rewrites,
   indexes, WAL, and a recovery backup. The migration uses a five-second lock
   timeout and runs transactionally through the normal migrator.
5. With API and worker writers stopped, take a fresh recovery dump and canonical
   baseline. Run the migration, compare fingerprints, and analyze the three
   rewritten tables. Start matching services and check public endpoints,
   ingestion, community evidence, raw diagnostics, privacy, and backup health.
   A writer pause can miss live IRC observations; the migration preserves all
   records already stored, not messages sent while collection is stopped.
6. Restore normal main-branch deployment only after checks pass. Retain the
   exact pre-migration backup and measured rollout results.

The migration also sets raw IRC table autovacuum/analyze scale factors to 2%,
so compaction's dead row versions can be reclaimed more regularly. Routine
vacuum reuses free space; it does not promise operating-system file shrinkage.

## Rollback

With writers stopped, execute
`packages/db/online-migrations/0018_restore_event_metadata.sql` through psql.
It restores JSONB and original labels, removes only migration 0017's entry,
and refuses to run when a newer migration exists. Allow room for expansion.
Compare canonical fingerprints before starting the old application images.
The older 0015/0016 rollback must not run until 0017 has been rolled back.

All representations and SQL functions are included in normal PostgreSQL
backups. No external codec service or extension is needed for recovery.
