# Daily membership summaries and seven-day detail retention

The operator authorized this retention change on 2026-11-04. It replaces
indefinite JOIN/PART event retention in ADR 0017. Chat messages, viewer samples,
raw IRC evidence, and EventSub retention are unchanged.

## Meaning

Each retained JOIN or PART contributes one appearance signal, not a unique visit.
Summaries are keyed by UTC date, stream/channel context, and stable account ID
(or unresolved login). Lifetime channel totals sum these daily rows. Keeping the
date and first/last observation preserves the 60-day community-map criteria.

Durations describe chat presence, never verified video viewing:

- A JOIN followed by PART within one recorded capture window contributes matched
  time. Twitch delivery can still be delayed or incomplete.
- A first PART estimates a missing JOIN from the later of stream start and
  capture start. Repeated PARTs add appearances, but no additional duration.
- A repeated JOIN closes the preceding interval as estimated and starts a new
  interval. A final JOIN closes at the earlier of stream end and capture end.
- Historical events without capture windows use stream bounds and contribute
  estimated time, including historical JOIN/PART pairs.
- Overlapping windows are unioned; estimated time excludes matched intervals.
  Intervals are split at UTC midnight. Events outside stream bounds still count
  as appearances, but cannot extend duration outside those bounds. Offline and
  anonymous observations contribute counts only.
- Capture windows start when the bot's room JOIN is observed, or at the first
  membership event if that acknowledgement is missing. Socket disconnect and
  room PART close coverage. An unclean restart closes abandoned windows at their
  last observed membership signal, avoiding invented time during an outage.

## Processing and retention

The maintenance loop processes up to 50 expired contexts every five minutes,
one atomic transaction per context. A context becomes eligible when its stream
has ended and both stream end and its latest event precede UTC midnight minus
seven days. Active streams remain detailed until they finish. This intentional
exception avoids splitting sessions at the retention boundary. Offline contexts
process their expired events even if fresh offline observations keep arriving;
those observations have appearance counts but no stream duration.

Queue locks exclude simultaneous processors. Summary writes, preservation of
legacy raw-evidence erasure links, source deletion and unreferenced identity
cleanup commit together. Failed transactions can be retried. Late events after
a context was summarized add counts but no additional duration, avoiding overlap
with already finalized time. Deduplication of raw events is bounded by retention.

Detailed histories show the retained events; the private chatter page combines
all summarized and recent appearance counts. Its duration columns include only
processed history. The community builder combines raw and summarized evidence,
using original event counts and date/first/last boundaries, not estimated time.
Privacy completion deletes subject summaries and redacts legacy raw evidence
through the retained links under the existing coordination lock.

Existing stream activity buckets are retained. Do not rebuild old per-minute
membership buckets from the pruned event table; daily summaries cannot restore
that granularity. Individual historical event IDs, exact sequences and metadata
are intentionally no longer retained in this ledger after summarization.

## Rollout

1. Pause Twitch worker ingestion and backup rotation; coordinate the deployment
   timer. Keep PostgreSQL running. Create a root-disk recovery archive, validate
   its catalog and SHA-256 before removing the previous volume backup.
2. Run integration tests on synthetic data, including missing/repeated events,
   overlap, midnight, retries, retention, community parity and privacy erasure.
   Build matching DB/API/worker/web images and pass release checks.
3. Apply migration 0029 with the worker stopped. It adds storage and an index;
   it does not delete history during application migration.
4. Record the original event count and current membership relation sizes. Run
   `node dist/rollup-membership.js --database twitch_tracker --apply` in the new
   migration image. The operation is resumable. Monitor volume and WAL headroom.
   Require remaining raw count plus summed appearance counts to equal baseline
   (with API privacy writes paused during this comparison).
5. Reclaim the event and identity tables with a separately scheduled rewrite
   while writers remain stopped, only after rechecking space. Deletion alone
   leaves reusable pages rather than guaranteeing filesystem savings. Compare
   actual relation sizes and backup size; do not claim projected savings as fact.
6. Start matching services. Verify collection, summary reads, community building
   and backup health; restore the deployment timer to its previous state.

The first release recovery archive is on the VM root disk at
`/srv/backups/twitch-membership-20261104/twitch_tracker_pre_membership_20261104.dump`.
Catalog/checksum validation is not a full restore drill. Retain it through release
verification. A code rollback cannot reconstruct discarded membership sequences;
full data rollback requires restoring this archive and loses subsequent writes.
