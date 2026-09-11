# Database structure and storage assessment — 2026-09-11

This document records the pre-implementation audit. See the
[implementation and validation report](storage-implementation-2026-09-11.md)
for the selected design and measurements from the full production copy.

Read-only production assessment of `vaarattu-server`, approximately 13:30–13:45 UTC, on deployed revision `74baecd`, PostgreSQL 16.14. This follows the [September 2 audit](storage-audit-2026-09-02.md) and [preservation-first decision](../adr/0017-preservation-first-storage-compaction.md). Preserve historical messages, membership events, viewer observations, source evidence, and meaningful metadata. No production data, schema, configuration, backups, or services were changed. Existing local application edits were left alone.

All GB/MB figures below use decimal units unless explicitly marked otherwise. Measurements occurred during live ingestion, so counts and sizes from different queries are not an atomic snapshot.

## Assessment

Further savings are available, but there is no single configuration switch that will make this database small. Most space is live historical data and its indexes. The highest-value structural change is lossless block compression of the raw IRC ledger, with compact identifiers and leaner observation rows as secondary improvements. Retaining all historical observations means growth continues even after these changes.

There is also a confirmed repeated-write defect in the chatter aggregation passes. Fixing it should precede physical compaction. Separately, host-wide capacity pressure has already prevented a scheduled backup; database optimization alone will not resolve all of that pressure.

## What occupies the space

Database size: **8,665,332,759 bytes (8.67 GB / 8.07 GiB)**. Application relation storage was approximately 8.66 GB, of which **2.56 GB (29.6%) was indexes**.

| Relation | Total GB | Heap GB | Index GB | Interpretation |
| --- | ---: | ---: | ---: | --- |
| `raw_irc_messages` | 2.857 | 2.509 | 0.346 | Largest target; wire data plus a separate row and indexes per delivery |
| `chat_messages` | 2.047 | 1.008 | 1.039 | Five indexes cost more than the heap |
| `chat_membership_events` | 1.311 | 0.769 | 0.542 | UUID identity, separate dedupe key, historical raw links, identity resolution |
| `raw_helix_responses` | 0.650 | 0.056 | 0.002 | Approximately 0.592 GB in TOAST and relation overhead, mostly response JSON |
| `chatter_channel_activity_buckets` | 0.553 | 0.357 | 0.196 | 2.40 million five-minute rows; repeated-write defect below |
| `stream_snapshots` | 0.495 | 0.243 | 0.252 | Metadata is already sparse; indexes now exceed heap size |
| `stream_activity_buckets` | 0.244 | 0.158 | 0.086 | 1.11 million five-minute rows |
| `ingestion_runs` | 0.156 | 0.149 | 0.007 | Mainly old operational history; new success sampling works |

The first three tables account for **71.7%** of the database. Raw EventSub is only 59 MB, and EventSub subscriptions about 1.2 MB; neither deserves another space-focused redesign now.

Host measurements, taken at slightly different times:

| Item | Approximate size |
| --- | ---: |
| Root filesystem used / available | 65.2 GB / 11.7 GB at the byte-count snapshot; reported usage varied from 85% to 87% during inspection |
| Twitch Tracker PostgreSQL volume | 9.41 GB, including database and PostgreSQL working files |
| Current WAL files | 0.587 GB; already included in PostgreSQL volume |
| Twitch Tracker backup directory | 1.895 GB, one completed dump |
| All Docker volumes | 35.7 GB, including Twitch Tracker; about 26.3 GB belongs to other volumes |
| containerd storage | 14.1 GB |
| Project directories | 5.0 GB |
| Host logs | 0.66 GB |

The largest other database volume alone was about 17.75 GB. These other applications were not audited. containerd usage is not a measurement of safely reclaimable cache. Do not add the database size to its enclosing volume, or Twitch Tracker's volume to the all-volumes total. `docker system df` failed while traversing a changing image-cache path; directory totals were used instead, and no image/volume cleanup is authorized by this report.

### Backup issue requiring attention before migration

The last completed dump was `twitch_tracker_20260909T162624Z.dump`, 1,895,487,953 bytes. The next attempt was rejected with `backup_preflight_failed reason=filesystem_critical filesystem_used_percent=95`. Failed attempts sleep for the full 86,400-second interval before retrying.

At inspection, the latest successful backup was about 45 hours old. Health still passed because its maximum age is 172,800 seconds (48 hours). The backup service also reports no verified off-host copy. Current disk usage had fallen below the rejection threshold, but this audit did not trigger a new backup or restore drill. Before any rewrite, obtain and restore-test a fresh recovery copy. A shorter bounded failure retry and immediate failure alert would address the gap between the daily backup objective and the current healthy status.

## Growth after the previous changes

The seven complete UTC days September 4–10 averaged:

| Observation | Rows/day | Earlier audit rows/day |
| --- | ---: | ---: |
| Chat messages | 188,148 | 94,539 |
| Membership events | 191,450 | 93,788 |
| Raw IRC deliveries | 199,639 | 199,767 |
| Viewer snapshots | 65,569 | 62,525 |

Raw IRC volume stayed roughly flat even though chat approximately doubled, because new JOIN/PART raw copies stopped on September 2. Parsed IRC tags were empty throughout the inspected sample; membership hashes were already shortened; only 2.8% of sampled viewer rows retained descriptive metadata. Those previous changes are working.

Recent raw IRC rows average 557 bytes before indexes; normalized chat averages 277 bytes, membership 198 bytes, and snapshots 133 bytes in samples. Applying recent row rates to these widths and current index/row costs suggests roughly **0.3–0.4 GB/day of additional database storage**, including allowance for rollups and smaller tables. This is a planning estimate, not a measured daily file-size delta. The retained dump grew by about 89 MB/day between September 7 and 9. The database's net change since September 2 is not a clean growth rate because compaction and index removal occurred during that period.

At unchanged workload, the combined database and one-copy backup can therefore add roughly 0.4–0.5 GB/day. Host usage is also volatile due to other applications. Do not infer an exact exhaustion date from current free space; the host already exceeded the backup threshold once.

## Ranked improvements

### 1. Fix aggregation passes that undo each other's timestamp updates

In `apps/worker/src/loops/aggregation.ts`, the message rollup writes message-only `first_activity_at` and `last_activity_at` at lines 351–352. The following membership rollup widens those same fields at lines 399–405. Where a membership observation lies outside the message range, the next message pass narrows it again. Each pass's `IS DISTINCT FROM` guard sees a real difference, despite unchanged source data.

A read-only query reproducing the current 48-hour, five-minute grouping found:

- 19,872 buckets with both message and membership input.
- 14,952 whose membership timestamps extend outside the message range.
- 14,903 of those buckets were already more than ten minutes old.
- The table update counter increased by 30,055 over about five minutes during the audit, consistent with approximately two writes per affected bucket.

At a similar affected population, that is about **8.6 million avoidable updates/day**. This is an extrapolation, not a full-day counter measurement. It costs WAL, vacuum work, and heap/index churn; it is not 8.6 million new durable rows.

Compute both sources' intended activity bounds together and write the final values once. Preserve separate message/membership counts. Verify that running aggregation twice on unchanged data performs zero updates on completed buckets, and that late arrivals and privacy deletion/rebuilds still produce correct bounds. Merely taking `least`/`greatest` forever would not correctly handle removal of source data.

The lifetime counters still include the older pre-fix workload: 2.62 TB of generated WAL and 1.21 TB of temporary I/O. Only 587 MB of WAL is currently retained on disk. Those lifetime values are not reclaimable storage.

### 2. Compress raw IRC in blocks while keeping every record recoverable

The raw ledger held about 5.56 million rows. Of these, 3.43 million PRIVMSG rows accounted for 1.99 GB of live tuples and 1.568 GB of wire-line column bytes. Normalized chat remains useful for queries; reparsing raw messages for every analytical request would exchange disk savings for substantial query cost.

I tested compression entirely in server memory, returning only aggregate sizes. Each record included all raw-table fields, including the exact wire line, ID, bot/connection identity, status, tags, and timestamps. Blocks used length framing and zlib level 6; each compressed block was decompressed and compared byte-for-byte to its input.

| Benchmark | Spread sample: 27,816 records | Recent contiguous sample: 20,000 records |
| --- | ---: | ---: |
| Wire bytes compressed individually / original wire bytes | 71.9% | 71.5% |
| Wire-only 64 KiB blocks / framed input | 30.3% | 28.6% |
| Complete-record 64 KiB blocks / serialized input | 26.6% | 26.7% |
| Complete-record 1 MiB blocks / serialized input | 25.6% | 25.4% |

This supports a design with a small indexed locator row per raw ID and a compressed payload block, initially around 64 KiB. The locator preserves existing foreign-key identity and time lookup; the block preserves all original fields. Keep active blocks appendable through a bounded ingestion buffer or staging table, then seal them. Explicitly design crash recovery so a locator cannot point to a missing block.

**Planning target: approximately 1–1.5 GB saved from today's 2.86 GB raw table**, after allowing for retained locator rows and indexes. The 73% serialization reduction is not a 73% reduction in the entire PostgreSQL table: locators, indexes, TOAST, page allocation, and block metadata remain. A physical restore-copy prototype must establish the actual saving and read latency.

Privacy deletion must rewrite affected blocks, and full restores must validate locators/checksums and exact raw replay. Keep the first implementation inside PostgreSQL so existing backup consistency is preserved. Moving blocks to object storage later could reduce local disk use further but introduces cross-system backup, availability, and deletion obligations; it does not itself reduce total bytes.

Changing only `default_toast_compression` will not produce these results. Most individual IRC rows are below PostgreSQL's usual approximately 2 KiB TOAST threshold; TOAST also compresses individual values rather than deduplicating repeated text across rows. The zlib benchmark is not a benchmark of PostgreSQL's pglz or LZ4 implementation. See [PostgreSQL 16 TOAST](https://www.postgresql.org/docs/16/storage-toast.html).

### 3. Use native UUIDs and binary hashes where the existing value permits it

All 3,432,936 chat message IDs checked were canonical UUID strings; every non-null reply-parent ID also matched UUID syntax. A separate full scan found zero textual changes after UUID cast and canonical serialization. PostgreSQL's native UUID represents 128 bits, avoiding the 36-character textual encoding. See [UUID type](https://www.postgresql.org/docs/16/datatype-uuid.html).

- Changing chat message/reply IDs to native UUID reduced sampled logical row width from **277 to 254 bytes**: approximately 79 MB across today's chat rows, before index effects. The 265 MB primary-key index should also shrink. Budget roughly 0.1–0.2 GB total as an unverified physical estimate.
- Membership already uses full SHA-256, encoded as 43-character base64url text. Store the same 32 digest bytes as `bytea`; do not truncate or switch to a collision-prone short hash. A sampled row simulation fell from **198 to 190 bytes**, about 28 MB in rows, with further saving in the 264 MB dedupe index. Index savings need a real rebuild benchmark.

Preserve API strings at the boundary and inspect every source/fallback before constraining future input. The current IRC missing-ID fallback is itself a UUID, but current data conformity alone is not a permanent third-party format guarantee.

Internal bigint identities can also replace some random UUIDs, reducing key width and improving append locality. They are secondary: changing raw IDs affects foreign keys, diagnostics, and migrations. Do not add an integer surrogate while retaining a second unique UUID index and assume a net saving. Likewise, do not drop the membership UUID primary key merely because it has zero scans; it supplies identity exposed by detail APIs.

Twitch user/stream IDs stored as short numeric text are a lower-value target than UUID text. Converting every ID across the schema is a large migration for a relatively small per-column saving. A local compact identity mapping could retain the external ID exactly, but needs measured total savings after mapping indexes and joins.

### 4. Make viewer observations a lean table, with metadata versions separate

Repeated titles/categories/tags have already been removed from most samples. The remaining expense is an individual UUID, repeated broadcaster identity, source reference, audit timestamps, tuple overhead, and three indexes for every observation.

Separate `(stream, observed_at, viewer_count, source_reference, stable observation ID)` from a small metadata-version table. Broadcaster ownership is available through the stream session; 18,388 sampled joins found no mismatch. In a sample, removing repeated broadcaster and sparse metadata columns reduced logical row width from **133 to 104 bytes**, around 51 MB gross at the current row count, before adding the metadata-version table. A more compact observation identity may save additional row/index bytes, but preserve stable pagination and equal-timestamp tie-breaking.

The broadcaster-time index is 93 MB and actively used. Removing the redundant broadcaster column requires replacement query plans that join sessions efficiently; do not count all 93 MB as free savings until those plans are measured. Overall this is a **tens-to-low-hundreds of MB** opportunity today, useful for long-term growth but smaller than raw IRC compression.

Preserve every timestamp, viewer count, metadata transition, and source link. `source_run_id` is populated with a raw Helix response ID in discovery, despite its name; do not drop it as unused ingestion-run metadata. Do not replace observation history with five-minute averages. Do not deduplicate equal viewer counts without retaining observation times and evidence that observations actually occurred.

### 5. Treat old membership wire rows as evidence to compact, not blindly delete

There are **1,865,868** old JOIN/PART raw rows (338 MB of live tuples), all ending on September 2. Exactly **1,822,722** distinct raw rows have membership references, and all those referenced command types match the normalized event type. Chat, channel-event, and room-state tables had zero references to JOIN/PART raw rows.

However:

- **43,146 raw rows have no membership reference.** Their meaning must be classified before removal.
- All 8,436 sampled linked wire lines matched the canonical line reconstructed from login, channel, and event type.
- Those same samples retained bot identity in the raw row, which membership rows do not contain.
- None had exactly equal raw and normalized receipt timestamps.

Thus dropping all linked raw rows would preserve the basic join/part fact but lose provenance and timing detail. Prefer compressing these records with the raw ledger, or migrate the missing provenance first. A rewrite that removes genuinely redundant legacy rows could gross roughly **0.4–0.5 GB including associated indexes**, but that is an upper planning estimate before replacement provenance storage and validation. It overlaps raw-ledger block savings and must not be added to them.

Do not turn JOIN/PART observations into inferred attendance intervals as a storage shortcut: missing events, reconnects, repeated joins, and membership uncertainty make that a semantic change.

### 6. Tighten operational representations, after establishing what is preserved

`raw_helix_responses` contains approximately 557 MB of stored response-column bytes: 324 MB from `/streams`, 233 MB from `/users`. Retention is still 30 days and collection started August 14, so no rows had aged out yet; zero maintenance redactions is expected, not proof of a broken timer.

All inspected Helix rows, including successful responses, remain marked `pending`. The maintenance code relies only on HTTP 2xx and age, not a recorded successful normalization. HTTP success alone does not prove downstream ingestion completed. Also, normalized profiles are overwritten and the name-history table is empty, so the claim that every historical profile fact is preserved elsewhere is too strong.

Before shortening the existing Helix-body window, record normalization completion reliably and define/version important profile changes. Then compare short replay storage with lossless compressed raw-response blocks. A short body window could remove several hundred MB of duplicate payload, but **zero-loss savings are not established by the current state model**. EventSub and chat history must retain their independent preservation policy.

Additional smaller opportunities:

- `rate_limit_observations`: 56 MB total; response headers average **651 bytes of a 768-byte row**. `readRateLimitHeaders` copies every HTTP response header. Keep typed quota fields and explicitly needed diagnostics, or compress exact headers if full preservation is required. About 42 MB of current logical header bytes are at stake, not gigabytes.
- `ingestion_runs`: 156 MB, largely legacy success telemetry. New hourly success sampling has limited growth to approximately 2,400 rows since the earlier audit. Compress or summarize legacy successes only after preserving any unique diagnostics; keep all failures.
- Five-minute chatter buckets: both optional JSON objects were empty in all 25,075 sampled rows. Omitting them reduced sampled row width by only **8 bytes**, about 19 MB across 2.4 million rows. Empty JSON cleanup is a minor opportunity, not a major redesign justification.
- Audit timestamps: `created_at=updated_at` in all sampled viewer rows, but not all chat or membership rows. Equal fields can be encoded with an explicit “same as” representation; distinct historical timestamps must not silently disappear. PostgreSQL alignment means an omitted field does not always translate into its nominal width in savings.
- `day` text can become a date; constant source/type values can use compact representations. These are low-priority improvements to combine with an already-justified rewrite, not reasons for a broad schema migration by themselves.

## Indexes, bloat, and alternatives

The large current indexes have real consumers. Chat's channel, chatter, stream, and global-time indexes have recorded reads; unique indexes enforce ingestion deduplication. There is no new obvious 1 GB pile of unused indexes.

BRIN is worth benchmarking for broad chronological scans, especially if cold rows are ordered by time. Current time/physical correlations are approximately 0.78 for raw IRC, 0.91 for chat, 0.82 for membership, and 0.68 for snapshots. These are imperfect after historical rewrites and updates. The two raw/chat global-time B-trees total 183 MB; that is a ceiling on that particular replacement opportunity. BRIN uses lossy block-range summaries and does not replace ordered B-tree top-N or selective channel/chatter access. See [PostgreSQL BRIN](https://www.postgresql.org/docs/16/brin-intro.html).

The raw table contains approximately 2.41 GB of live tuple data in a 2.51 GB heap, before line pointers and page overhead. That argues against a large raw-heap bloat reserve. Zero dead tuples does not prove perfectly packed indexes; exact index density was not measured. Neither `pgstattuple` nor `pageinspect` was installed, and this audit did not add extensions.

Tune autovacuum per frequently updated table after fixing churn, but smaller vacuum thresholds do not compress live rows. Lower fillfactor can improve HOT updates while consuming more heap space. Ordinary vacuum mainly makes space reusable; full rewrites need additional disk and can lock out ingestion. See [routine vacuuming](https://www.postgresql.org/docs/16/routine-vacuuming.html). Concurrent index rebuilding also needs temporary duplicate index space; see [CREATE INDEX](https://www.postgresql.org/docs/16/sql-createindex.html).

Partitioning alone does not compress records and may add indexes or complicate global deduplication/FKs. It becomes useful as a boundary for sealing and compressing old, immutable data while retaining it. Full columnar storage or Parquet could improve large immutable analytical scans, but mixed point lookups, moderation updates, identity backfills, and privacy erasure make a whole-database replacement premature. Prototype immutable viewer/aggregate history only after the simpler PostgreSQL changes; measure total storage including any retained source data and duplicate indexes.

## Recommended sequence and acceptance criteria

1. Address shared-host capacity and obtain a fresh, restore-tested backup. Investigate other volumes and containerd independently; do not prune live volumes based on size.
2. Fix the aggregation timestamp oscillation. Verify unchanged completed buckets produce no second-run updates; measure WAL/update deltas across several cycles.
3. On a restored copy, prototype native chat UUIDs and binary membership digests. Measure actual heap/index sizes and API/query compatibility, not only logical widths.
4. Prototype 64 KiB lossless raw-record blocks with stable locators. Measure total bytes including locators/indexes, ingest latency, diagnostic lookup latency, crash recovery, restore, and privacy rewrites. Compare 1 MiB blocks only if the small extra compression gain justifies larger read/erase units.
5. Consider lean viewer observations and metadata versions next. Benchmark channel history, stream history, live lookup, and stable pagination before changing indexes.
6. Improve the Helix processing/preservation contract before shortening its body retention. Apply smaller telemetry/JSON changes only where their savings justify their migration cost.

Do not sum all listed opportunities: raw compression and legacy raw removal overlap, column removal and key redesign share tuple overhead, and database compression will not translate proportionally to the already-compressed dump. A sensible initial prototype target is **roughly 1–2 GB of database reduction from raw-block compression plus compact keys**, with additional opportunities subject to the preservation decisions above. This is a target to validate, not a claimed achieved saving.

Verification performed: repository schema and writer/reader inspection; production catalog and index-use queries; exact command/reference/UUID counts; bounded row-width samples; recent complete-day counts; server-memory compression with decompression equality checks; aggregate reproduction of the timestamp oscillation; backup health/log inspection; broad disk directory totals. No application test suite was run because application code was not changed. No physical candidate tables/indexes were built, no full backup restore was performed, and no production cleanup was executed.
