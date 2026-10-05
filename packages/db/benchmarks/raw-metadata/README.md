# Bounded raw IRC metadata experiment — 2026-10-05

Recommendation: **do not ship this layout**. It preserves the tested records and
reader results, but saves only about 5% of complete raw storage on the bounded
historical sample. Bulk insertion roughly doubles in cost, and full metadata
lookups and privacy redactions become slower. No application source, normal
migration, ingestion setting, index-removal policy, or retention rule is changed.

## Candidate and reader dependencies

Existing raw context sharing and wire PGLZ packing already remove substantial
redundancy. This experiment moves tags, processing status, parse errors, and
creation/update timestamps into typed arrays alongside the existing wire blocks.
UUID, receipt time, context reference, parsed command, and source-attribution flag
remain in an indexed locator row. Recent/unpacked data has a separate hot table.
The context dictionary, global UUID constraint, complete time index, unpacked time
index, hot primary index, payload table/index/sequence, TOAST, and metadata arrays
are all charged to the candidate.

Parsed command deliberately stays outside the block: the stream diagnostic
reader selects it for each message. A first 2,000-row smoke test that packed this
field made one diagnostic query about 27 times slower through repeated block
decoding. Keeping the field in the locator removed that regression.

Relevant source contracts:

- `packages/db/src/raw-irc.ts`: expand each needed wire block once for bulk reads.
- `apps/api/src/routes.ts`: stream diagnostics join raw UUIDs and parsed commands;
  privacy erasure replaces the line and clears tags/error metadata.
- `apps/worker/src/community-input.ts`: source attribution needs the cached flag
  and the inline-line fallback, without unpacking cold metadata.
- `apps/api/src/stream-detail.ts`: ordered message history with stable IDs.
- `packages/db/migrations/0015_raw_irc_blocks.sql`: bounded packing, row locks,
  exact wire preservation, and removal of archived slots on replacement/deletion.

The baseline reproduces the current raw schema and packer, using fresh physical
relations. It does not count existing production bloat as a structural saving.
The candidate exposes a read compatibility view and explicit benchmark mutation
functions. It is **not** a complete writable application adapter or migration.
No prior chat-normalization prototype is reused.

## Data boundaries and bias

Only **8,192 production raw observations / 7,168,835 uncompressed extracted bytes**
were copied in one successful extraction. Referenced context values are embedded
in those bytes and deduplicated locally. The file and extraction ledger live in
the already ignored `.cache/raw-metadata-bench/` directory. They must never be
committed, included in a public report, or printed.

`sample.mjs` selects at most 1,024 observations from each fixed one-hour UTC window:
August 20, September 5, September 21, and October 2, 2026, at 04:00 and 17:00.
Each window reached its row cap; the samples therefore favor its earliest
observations, rather than covering the full hour. The eight cohorts contain
27, 91, 41, 130, 32, 148, 33, and 150 distinct contexts respectively. The labels
quiet/active describe the intended time-of-day strata, not measured full-hour rates.
These are not random or volume-weighted production samples.

The extractor enforces an 8,192-row / 20 MiB attempt cap in SQL and an output byte
cap in the client. It reserves each attempt in a persistent local ledger before
connecting. Total reservations/actual completed extraction across attempts cannot
exceed 100,000 observations or 100 MiB. Failed/interrupted attempts retain their
full reservation. Do not remove/reset this ledger to take more samples. Server
access is a read-only repeatable-read transaction with 10-second statement and
one-second lock timeouts. There are no server files, temporary benchmark tables,
or production maintenance operations.

A separate deterministic 30,000-row synthetic fixture spans four historical
periods and 2.5% recent hot data. It includes busy/quiet contexts, microseconds,
distinct creation/update times, equal receipt timestamps, exceptional tags,
failed/pending processing, null contexts/commands, empty lines, Unicode, JOIN/PART,
and relayed/unrelayed messages. Synthetic wire entropy is not a production model.

Only raw records and their context values were extracted. The normalized message,
stream, privacy, and bot *consumer graph is synthetic* for both runs. It exercises
the same SQL access patterns without copying another production table. Existing
consumer indexes remain unchanged. Reported comparisons are SQL result parity,
not a full HTTP endpoint or ten-million-row load test. Viewer observations were
not prototyped: the scope deliberately stays on the larger raw-metadata candidate.

## Method and results

Both layouts consume exactly the same input records. Their wire blocks are rebuilt
using the same ordered 256-row algorithm; original public IDs, timestamps, source
context values, encoded tags and exact wire text are compared. Physical payload
block IDs/positions are internal and regenerated. Source-attribution caches are
validated against the existing packer's wire predicate.

PostgreSQL 16.14 runs locally with two CPUs and 2 GiB memory, on disposable tmpfs.
Read measurements use `EXPLAIN (ANALYZE, BUFFERS)`: five warmups and 20 measured
runs, alternating layout order. They measure warm-cache server execution, not
network latency, durable-disk throughput, or production tail latency. Packing is
interleaved between layouts in 256-row batches. Insertion and packing wall time
include the local client round trip. Redaction uses five rollback-isolated trials.
WAL counters include normal page-image effects and are not storage-reclamation
figures.

`results.json` contains sanitized measurements. Full local outputs and per-relation
breakdowns remain in `.cache/raw-metadata-bench/`.

| Complete raw footprint, after local rewrite | Baseline bytes | Candidate bytes | Saving |
| --- | ---: | ---: | ---: |
| Historical sample, 8,192 rows | 3,194,880 | 3,039,232 | 155,648 / 4.87% |
| Synthetic mixed history, 30,000 rows | 9,052,160 | 8,339,456 | 712,704 / 7.87% |

These totals include heap, every raw index, TOAST and its indexes, context
dictionaries, hot records, locators, and block sequences. The unchanged synthetic
consumer fixtures are reported separately and add the same bytes to each layout;
including them reduces the percentage saving further. Input/staging copies are
benchmark machinery, not serving structures. Their storage is not hidden inside
the candidate total.

On the historical sample, bulk insertion was about 132 ms versus 256 ms; packing
was about 350 ms versus 344 ms. Full metadata point reads were about 0.24 ms versus
0.36 ms. Stream diagnostics and 200-line bulk diagnostics stayed close to baseline.
Community attribution rose from about 7.5 to 8.6 ms. Redacting 20 rows took about
14 to 21 ms within one block, and 25 to 31 ms across blocks. See the JSON for
repeated-run medians/p95 and the final verification run; small timings fluctuate.

The two fixtures save approximately 19–24 bytes per observation. Multiplying
that by the previously measured ~10 million raw rows gives **roughly 0.18–0.22 GiB**
as a structural planning estimate, not a measured production saving. Finite-sample
overhead, real hot fractions, block occupancy, indexes and future entropy can alter
it. Do not apply 5–8% to the whole database or add index-removal/Helix opportunities
to this experiment's saving.

Packing alone did not reduce allocated files: before local rewrites the historical
candidate occupied about 7.77 MiB versus baseline 7.40 MiB, and the synthetic
candidate about 25.02 MiB versus 21.24 MiB. Local `VACUUM FULL` plus ordinary vacuum
was used only to compare equally compact end states and visibility maps. Ordinary
vacuum makes old pages reusable; it does not promise equivalent filesystem release.
No production filesystem bytes have been reclaimed.

## Correctness actually exercised

- Every fixture record's logical fields and exact wire reconstruction, including
  microseconds, exceptional metadata and context references.
- Equal reader results for stream/channel/user history, raw point/bulk diagnostics,
  the source-attribution join/aggregation, and time-index pagination.
- Packing rollback, visibility from another connection, locked-row skipping, and
  a competing packer that cannot consume locked observations.
- Late historical inserts and new ingestion while another packing transaction is open.
- Privacy erasure racing with packing: erasure waits for the key lock and clears
  the newly committed wire slot; candidate metadata slots are cleared too.
- Explicit empty replacement, unchanged neighboring observations, physical deletion,
  foreign-key rejection of referenced deletion, duplicate IDs, and missing locators.
- Normalized moderation marks leave raw evidence intact.

These tests cover the prototype's bounded operations, not every possible future
writable-view update or long-running concurrent production workload.

## Reproduce without a full database copy

Run from the repository root with the installed dependencies and Node 24.19.
Use a new run name every time; existing schemas are never dropped/reset by the
runner. Run the measurements sequentially without competing benchmarks/builds.

```powershell
docker run --detach --name twitch-raw-metadata-bench-20261005 `
  --label codex.task=raw-metadata-bench-20261005 `
  --publish 127.0.0.1:55436:5432 --tmpfs /var/lib/postgresql/data:rw,size=1536m `
  --memory 2g --cpus 2 --shm-size 128m `
  --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=raw_metadata_benchmark `
  --env POSTGRES_USER=benchmark `
  postgres:16.14-alpine3.24@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
docker exec twitch-raw-metadata-bench-20261005 pg_isready -U benchmark -d raw_metadata_benchmark

node packages/db/benchmarks/raw-metadata/benchmark.mjs --name synthetic_repro --rows 30000
node packages/db/benchmarks/raw-metadata/benchmark.mjs --name sample_repro `
  --sample .cache/raw-metadata-bench/sample_1.ndjson
```

The loopback-only trust setting belongs exclusively to this disposable local
experiment. The runner rejects non-loopback connections, another database name,
and PostgreSQL versions other than 16. It never reads `DATABASE_URL`.

Reuse the existing sample. `node packages/db/benchmarks/raw-metadata/sample.mjs`
is the bounded extraction command for an explicitly authorized source investigation,
not a prerequisite to repeat a local benchmark. It is not an automatic test step.
Do not substitute a full dump, volume copy, full restore or accumulating cohort sweep.

Repository checks: `corepack pnpm check:structure`, `corepack pnpm lint`,
`corepack pnpm test`, `corepack pnpm typecheck`, `corepack pnpm build`.
The suite passed 134 tests; 14 database integration files were skipped without a
`TEST_DATABASE_URL`. The standalone benchmark performs its own PostgreSQL checks.
An initial unit run under system Node 24.4 failed a worker-module import; using the
required Node 24.19 runtime resolved it without source changes.

Stop/remove only the container carrying this experiment's name and label when
finished. Its tmpfs data is disposable; keep the scripts, sanitized results, and
private bounded input/ledger if a rerun is needed.

## Proposed direction, not a rollout

The current prototype is a no-go: a projected few hundred MiB does not justify
split writes, slower metadata/erasure, a compatibility adapter and a production
rewrite. The server's roughly 11–12 GiB shared free space must also cover old/new
relations, indexes, WAL, backup overlap and other services. No reliable migration
peak-space or downtime estimate was measured here.

A readable historical archive is a separate proposal. Keep recent writes in the
current schema and stable UUID/source-attribution lookup entries online. Store
older exact wire/metadata blocks off-host, with schema version, lossless timestamp
and byte encodings, a checksum and an atomic generation manifest. A reader batches
requested UUIDs by block and merges hot/cold results using the existing time/ID
ordering. Privacy changes must invalidate caches and atomically replace affected
blocks, with explicit deletion completion and backup lifecycle handling; late
arrivals enter the hot path. Do not discard source facts or replace observations
with averages.

The smallest next implementation step would be a **local one-block archive adapter
test** using the already bounded input: exact export/import, batch diagnostics,
pagination and erasure across manifest generations. Measure the remaining online
locator/index cost and cold-read latency before proposing any production movement.
No external archive, production migration, retention change or index removal is
implemented or authorized by this experiment.
