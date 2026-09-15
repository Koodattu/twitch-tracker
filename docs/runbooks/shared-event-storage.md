# Shared event storage

Migrations 0018 and 0019 preserve event history while removing values that are
already derivable or shared. They require matching worker/DB code and a
coordinated deployment. Do not let the VM's main-branch auto-deployer apply them
before the maintenance procedure below is ready.

## Membership digests

`chat_membership_events.dedupe_key_storage` contains either NULL, a complete
32-byte digest, or an empty byte string. Empty means that `derive_membership_key`
reconstructs the original SHA-256 digest from the channel, stream, event type,
observed login, and event timestamp truncated to a second. The rule matches the
worker's existing algorithm; it does not replace the digest with a shorter hash.
New IRC membership inserts request this representation directly with an empty
storage value, avoiding duplicate hash computation and transmission by the worker.
Timestamps, including microseconds, remain unchanged in the record.

Only digests that compare exactly with the derived value are compacted. NULL,
unusual, historical, or non-reconstructible keys remain verbatim. The unique
expression index uses `read_membership_key`, so duplicates still conflict across
both representations. The worker uses `ON CONFLICT DO NOTHING` because its
pinned Drizzle version does not accept expression conflict targets.

The `membership_key_guard` trigger materializes the original digest before an
update changes a derivation input. Privacy deletion and login/timestamp repairs
therefore keep the original dedupe identity. Explicitly replacing the stored key
still replaces it. Do not change the derivation function in place: changing an
immutable indexed function could change historical identities and invalidate the
index. Introduce a versioned representation and a verified migration instead.

Use the exported `membershipDedupeKeySql` expression for a logical digest in
Drizzle reads (PostgreSQL returns a Buffer). `dedupeKeyStorage` is physical data,
not the logical digest. Direct SQL uses:

```sql
SELECT read_membership_key(broadcaster_user_id, twitch_stream_id, event_type,
  chatter_login, event_at, dedupe_key_storage)
FROM chat_membership_events;
```

The membership BRIN indexes capture time ranges without one entry per event.
The chat BRIN covers the event-time expression used by aggregation. Both enable
autosummarization; normal vacuum also summarizes new ranges. No history window,
bucket calculation, or event filter is narrowed by these indexes.

## IRC contexts

`raw_irc_contexts` stores each exact combination of historical channel login,
bot account ID, and connection ID once. `raw_irc_messages.context_id` references
it. NULL context means all three values were NULL. Empty strings and partial-NULL
combinations remain distinct. Contexts preserve the original bot/connection
foreign keys and are immutable so edits cannot silently change many old events.

The worker calls `get_raw_irc_context` inside its raw-message insert. Existing
contexts are read without updating them. Concurrent first inserts resolve to
the same context; only that rare conflict performs an unchanged-row update.
This avoids rewriting a shared context on every message. No application cache
or external dictionary service is required.

```sql
SELECT r.id, c.channel_login, c.bot_account_id, c.irc_connection_id
FROM raw_irc_messages r LEFT JOIN raw_irc_contexts c ON c.id = r.context_id;
```

The existing wire payload blocks, exact lines, tag handling, source-attribution
cache, and privacy slot-erasure triggers are unchanged. These migrations do not
convert JOIN/PART observations to watchtime or discard individual visits.

## Rehearsal and deployment

1. Stream a fresh consistent production dump to a new local PostgreSQL container
   and retain the dump. Keep a pristine baseline and a separate candidate. Use
   another database containing only synthetic fixtures for integration tests.
   Check free space both on the host filesystem and inside Docker's data disk;
   they can have different capacity limits.
2. Fingerprint the complete baseline with `db:verify-storage --database
   <exact-name> --layout metadata`. The verifier reconstructs both layouts.
3. Migrate the candidate, run `VACUUM (FULL, ANALYZE)` on membership and raw IRC,
   and compare the fingerprints. UPDATE/DROP COLUMN alone does not guarantee a
   smaller on-disk table. Record format savings relative to the fresh-restored
   baseline separately from reclaimed production bloat.
4. Test ingestion, uniqueness, metadata edge cases, privacy redaction, and
   historical reads. Check aggregation result equality and EXPLAIN buffers, not
   only timing. Restore a full candidate dump into another database and verify
   it. Rehearse rollback and compare again.
5. Guard the production checkout against automatic deployment; wait for CI and
   build the exact release. Retain old images. Check space for expanded tables,
   indexes, WAL, temporary files, and the recovery dump. Bulk context backfill
   validates its new foreign key after the update to avoid per-row FK events.
6. Stop API/worker writers, take a fresh recovery dump and canonical fingerprint,
   migrate, reclaim table space, and compare. Restart matching services only
   after validation. Collection is paused during this window; stored history is
   preserved, but live IRC observations during the pause can be missed.
7. Verify fresh ingestion, all worker loops, endpoints, cache health and a new
   successful backup. Restore the main checkout and normal deployment state.

## Rollback

With writers stopped, execute
`packages/db/online-migrations/0020_restore_shared_storage.sql`. It refuses to
run unless 0019 is the latest migration, expands full membership keys and IRC
metadata, and removes only 0018/0019's migration records. Verify canonical
fingerprints before restarting the pre-migration images. Allow disk space for
the expanded representation. Older rollback scripts must run only after this
rollback restores their expected schema.

All representations use PostgreSQL's built-in types and SHA-256 function; no
additional production dependency or extension is needed.
