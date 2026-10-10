# Native row width audit

Narrower keys are an incremental saving of approximately **0.50–0.53 GiB** at the
October 10, 2026 production volume. A substantially broader bundle of row
encodings models **1.33–1.37 GiB gross**, before dictionary costs. Neither result
supports treating this as a several-GiB solution with unchanged history and
erasure performance.

The database occupied 13.087 GiB at 12:46 UTC. This audit changes no application
schema, migrations, production data, or infrastructure. The results are in
[results.json](results.json), with production catalog evidence in
[production-catalog.json](production-catalog.json), aggregate width measurements
in [production-widths.json](production-widths.json), and local physical sizes in
[keys-results.json](keys-results.json).

## Remaining byte budget

These projections use production live-row estimates, measured aligned tuple
widths, and an index-size control. They are gross savings before mapping tables;
the broader column includes the narrower-key saving rather than adding to it.

| Relation | Integer keys only GiB | Broader row encoding GiB |
| --- | ---: | ---: |
| Chat messages | 0.375 | 0.669 |
| Viewer snapshots | 0.117 | 0.198 |
| Raw IRC locator rows | 0 | 0.331 |
| Membership events | 0 | 0.083 |
| Membership identities | 0.008–0.036 | 0.008–0.036 |
| Stream activity buckets | 0.038 | 0.057 |
| Total with optimistic identity index credit | 0.566 | 1.373 |

Charging complete new user and stream maps, including their heap, both lookup
indexes, and identity sequences, costs about **0.041 GiB**. This deliberately
duplicates the existing parent tables instead of assuming their extra key is
free. It leaves **0.497–0.525 GiB** for the keys-only proposal. The range allows
zero to full index credit on membership identities: duplicate posting tuples
and a partial index make full credit optimistic.

The broader model leaves about **1.332 GiB after user and stream maps**, still
before the historical-login map and its erasure work. Its cardinality is not
measured: current user logins cannot substitute for all historically observed
logins. This is a favorable gross budget, not a demonstrated net result.

Using the alternative `reltuples` population estimates produces 1.332 GiB gross.
Assuming 90% heap and 70% B-tree page occupancy increases the gross projection to
1.584 GiB. Those occupancies are a sensitivity scenario, not measured bloat or a
confidence interval. Rebuilding existing indexes may reclaim other space, but
that space must not be credited to narrower keys.

## Encodings included

The keys-only case replaces repeated user and stream strings with integer
surrogates. Their exact original spelling stays in unique dictionaries. Each
history index still contains the direct subject key followed by its original
timestamp. Chat rows save about 18.66 heap bytes; viewer rows save 16 bytes.

The broader model also reorders fields to reduce padding, stores common labels
and non-null defaults as nullable overrides, and represents nearby non-ordering
timestamps as integer microsecond deltas with full timestamp overflow fields.
It models a historical-login dictionary for chat, an integer raw payload-block
key, and a small membership flag field. It retains native history timestamps,
UUIDs, binary message IDs, raw payloads, exceptional values, and row boundaries.
These are width expressions, not implemented codecs or a validated migration.

Several apparent opportunities are already exhausted. Message IDs and JSON
metadata already have binary encodings; raw IRC contexts and membership
contexts/identities already use integers; membership defaults and duplicate
timestamps already have overrides. They receive no second credit here.

Replacing a UUID with an integer does not automatically recover its 16 bytes.
Preserving the original UUID and its exact lookup requires retaining that value
and index, then adding the surrogate and another uniqueness structure. For raw
IRC, the new per-row cost can exceed the savings on incoming references. Dropping
identifiers or deduplication guarantees is outside this preservation audit.

## Measurement and verification

Production queries used read-only transactions with 10-second statement and
1-second lock timeouts. Three fixed-seed `SYSTEM(0.08)` samples per relation
returned only counts and average sizes. Every sample stayed below its
20,000-row cap. Page sampling is not a statistical guarantee for future data.
Tuple widths include eight-byte alignment and the four-byte line pointer, as
described in PostgreSQL's [page layout documentation](https://www.postgresql.org/docs/16/storage-page-layout.html).
Short strings already use compact headers, so character count alone overstates
their cost; see [TOAST storage](https://www.postgresql.org/docs/16/storage-toast.html).

Seventeen of eighteen original-row measurements matched stored tuple widths
exactly. One identity sample differed by eight bytes across 1,612 rows. The
projection uses the smaller baseline, excluding that discrepancy from savings.

The local PostgreSQL 16.14 fixture reused the existing bounded sample: 20,856
chat records and 869 viewer records. Both baseline and candidate used fresh
native index builds. The complete user/stream map footprint was measured
separately. Chat storage fell from 9,027,584 to 8,060,928 bytes before those maps.
A 100,000-row index control saved 901,120 bytes, about 9.01 bytes per entry after
page overhead, when changing `(text, timestamp)` to `(integer, timestamp)`.

Bidirectional `EXCEPT ALL` verified every logical field of all 21,725 records,
preserving timestamps inside PostgreSQL. A separate check retained distinct
`000123`, `123`, and non-numeric IDs. The fixture omits FK/check validation on
both sides and does not establish application write correctness or latency.
Node was 24.4.1; the repository declares a newer Node 24 minimum.

No new observation records were exported. The extraction ledger remains
29,917 rows and 25,117,896 uncompressed bytes. Only sanitized aggregate evidence
is saved in this directory; the private sample remains in ignored local cache.

## History and erasure requirements

An implementation must resolve an external subject once, use the native
`(subject_id, time)` index to select the page, then expand only selected rows.
Joining and sorting the entire history through a context table would repeat the
previous normalization regression. Smaller indexes alone do not prove equal
end-to-end latency; mapping lookups and timestamp decoding still add work.

Erasure must retain the existing user-ID **or historical-login** matching,
source-record linkage, archived-wire clearing, and membership identity cleanup.
Any new dictionary containing personal data needs corresponding cleanup. These
paths were inspected but were not reimplemented or timed in this audit.

The measured byte budget does not establish several GiB of immediate saving.
It does support evaluating a combined package for sustained growth reduction,
as described below. This audit does not establish a universal upper bound on
every possible encoding or on unrelated payload compression and bloat reclamation.

## Combined storage plan

Implementation update: the verified native-key/row package and rollout procedure
are in [the native-record runbook](../../../../docs/runbooks/native-record-storage.md).
Its measured-layout projection is **0.74 GiB**, including parent keys/indexes.
The larger estimates below describe the original, broader model; they are not
the saving delivered by migrations 0024–0028. Production is not migrated.

The objective is to reduce both retained history and bytes added by future
observations while preserving history and erasure performance. A change need
not save several GiB by itself to contribute. The compatible package combines
direct integer keys with the native row encodings in this audit.

| Additive work | Estimated saving at current volume |
| --- | ---: |
| User and stream keys, after their mapping tables | 0.497–0.525 GiB |
| Additional raw row encoding | 0.331 GiB gross |
| Additional chat, viewer, membership and bucket row encoding | 0.476 GiB gross |
| Combined package | **1.304–1.332 GiB before historical-login mapping costs** |

The 0.5 GiB key saving is already inside the broader package. Each dictionary is
charged once. The [raw metadata blocks](../raw-metadata/README.md),
[history blocks](../history-blocks/README.md), and
[posting pages](../history-postings/README.md) cannot be added to this budget:
they replace overlapping representations and retain measured regressions. Their
useful findings carry forward as design requirements: retain direct ordered
indexes, avoid decoding blocks for ordinary histories, keep source lookup cheap,
and preserve individual-row mutations. Existing production compaction remains
part of the baseline and continues to benefit new data.

At a constant observation mix, row widths, index occupancy and proportional
dictionary growth, the combined package scales as follows. These are modeled
scenarios, not measured net savings or a forecast of when the database grows.

| Comparable retained history | Saving before historical-login maps |
| --- | ---: |
| Current volume | 1.30–1.33 GiB |
| Twice current volume | 2.61–2.66 GiB |
| Three times current volume | 3.91–4.00 GiB |

Before dictionary costs, every additional million chat records saves about
77.7 MiB in this model; a million raw IRC rows saves 30.1 MiB, viewer records
54.9 MiB, and membership events 9.5 MiB. These are separate record populations.
An incoming chat can also produce a raw IRC row; it must not be counted as two
chat records. Actual growth depends on ingestion mix and dictionary reuse.

Implementation should proceed in independently verified stages:

1. Integrate direct integer keys with native ordered history access, retaining
   exact external strings, UUIDs, deduplication and source links. Measure the
   complete mapping cost and all affected application read/write paths.
2. Add row encodings to that same candidate, measuring incremental savings over
   the first stage. Start with raw locator metadata, then add chat/viewer and
   membership encodings. Historical-login sharing requires explicit erasure
   handling before it can contribute to an accepted net saving.
3. Compare the complete candidate against the current schema using the existing
   bounded samples and larger synthetic workloads. Check full-field equality,
   history pagination, diagnostics, concurrent ingestion, erasure, WAL and
   rollback. Advance only stages without a material measured regression.
4. Encode new writes in the accepted format and migrate retained history with
   a resumable process. Reclaim existing filesystem space through a separately
   planned rewrite after checking current disk/WAL headroom. Smaller new rows
   reduce future allocation; changing writes alone does not shrink old files.

This consolidates the implementation direction. No combined application adapter,
production migration, release or production filesystem reclamation has been
performed. End-to-end performance and the final net saving remain release gates.

## Reproduction

`catalog.sql` captures safe catalog metadata. `node widths.mjs` generates the
aggregate-only `widths.sql`; execute both on an authorized read-only connection
with the timeouts above and save the JSON results. Never export the sampled rows.
`node keys.mjs` requires the existing private sample and an empty disposable local
`history_blocks_benchmark` database; the connection guard rejects other hosts and
database names. It creates only its `narrow_audit` schema and fails if it exists.
`node summarize.mjs` regenerates the projection from the saved evidence.
