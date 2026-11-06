# Thirty-day retention for normalized chat wire copies

Authorized on 2026-11-06. Structured chat messages remain indefinitely, including
their text, IDs, timestamps, badges, emotes, replies, shared-chat source, and
moderation state. This policy removes only the older duplicate IRC wire envelope;
unmodeled tags and the exact envelope are intentionally unavailable after expiry.
Diagnostic API reads return a null raw-wire reference/line for expired copies.

Migration 0035 adds a nullable `unrelayed_source` classification to chat records
and their writable compatibility view. New IRC writes populate it. Community
queries prefer the stored classification and retain the raw fallback for legacy
rows. Expiry copies that exact fallback before clearing the raw reference, so
ordinary, relayed, and unknown-source eligibility does not change.

Only processed `PRIVMSG` records older than UTC midnight minus 30 days qualify.
They must have a structured chat reference, and every referencing message must
be an older, complete IRC chat message. Raw records referenced by membership,
channel, or room-state events remain. Unlinked, incomplete, failed, and other
command records remain. Source classification, reference detachment, raw deletion,
and clearing compressed archive slots are one retryable transaction. Other slots
in mixed archive blocks are preserved. The existing privacy coordination lock
prevents races with subject erasure.

Maintenance expires at most 5,000 copies every five minutes in 1,000-row batches.
For the initial backlog, run the migration image command:

```sh
node dist/expire-chat-wire.js --database twitch_tracker --apply
```

The command defaults to 1,000 records per transaction. `--batch-size` accepts
1–5,000 for measured backfill tuning; each transaction retains a 60-second timeout.

Before running it, protect a validated recovery archive from backup rotation.
Record a fixed ingestion fence after draining writes. In a repeatable-read
snapshot, fingerprint immutable structured chat fields across the fenced history,
and all fields including moderation state for the older messages subject to expiry.
Exclude the retired wire link and new physical classification, and include the
effective classification instead. Recent live moderation updates may continue.
Also fingerprint retained non-chat wire payloads. Compare
counts and both canonical fingerprints after processing the fenced data.

Use bounded transactions and monitor table growth, WAL and temporary-file space.
Reclaim the chat records, raw records, and payload-block tables only after
preservation checks pass, with application writers paused and enough space for
each rewrite. Restore services and verify ingestion, community behavior, and a
new backup. Keep the recovery archive separately: code rollback cannot recreate
expired wire envelopes. The original failed membership verifier and its corrected
consistent-snapshot procedure are documented in `membership-daily-retention.md`.
