# Production storage audit: 2026-09-02

This is a dated evidence snapshot, not a production change record. All host and
database inspection was read-only. No production files, containers, jobs,
configuration, rows, schema, or backups were changed.

## Capacity and recovery copies

| Item | Observed size |
| --- | ---: |
| Root filesystem | 80,290,492,416 bytes total; 65,290,690,560 used; 11,672,199,168 available; 85% reported |
| `twitch-tracker_postgres_data` Docker volume | 7.748 GB reported by Docker |
| `/srv/backups/twitch-tracker` | 12,350,069,023 bytes |
| PostgreSQL database | 6,696,066,071 bytes (`6386 MB` from `pg_size_pretty`) |
| `public` schema relations | 6,686,449,664 bytes |
| `drizzle` schema relations | 32,768 bytes |

Both `/` and `/srv/backups/twitch-tracker` resolve to `/dev/sda1` (`ext4`). No
Restic, rclone, Borg, or project-specific backup service/timer was visible in
Docker or systemd. Cron and any external control plane were not inspected to
avoid exposing command-line secrets. A historical manual copy cannot be ruled
out, but no active off-host destination was established by this audit.

There are 15 daily dumps from August 18 through September 1. The first is
292,357,736 bytes and the latest is 1,344,218,799 bytes: an increase of
1,051,861,063 bytes over 14 days, or about 75.1 MB/day. The retained directory
contains matching 103-byte SHA-256 sidecars and a current `.last-success`
marker. The backup container is healthy, has not restarted, and produced no
errors in its available logs.

The deployed backup script exactly matched repository commit `2a71b7c` at audit
time. It creates a custom-format dump, validates the archive catalog, and
generates a checksum, but its `find -mtime +14` rule effectively leaves about
15 daily dumps because age is rounded down to whole days. The health check only
tested that `.last-success` was non-empty; it did not test freshness, capacity,
or the referenced files. The restore script verifies the checksum and archive
catalog before restoring into a required empty, non-production database. No
machine-readable restore-drill record. None was present in the backup directory,
so historical manual restore testing was not established.

The dump catalog contains every application table, including raw ledgers and
authentication/privacy tables. This is correct for a full recovery copy, but it
means off-host copies need encryption, restricted access, and lifecycle rules.
The dump omits owners and privileges, so a restore depends on an already-created
empty database and an appropriate PostgreSQL role; the schema and table data are
inside the archive.

## PostgreSQL configuration and storage profile

PostgreSQL is 16.14 on Alpine, with 8 KiB blocks, `wal_level=replica`,
`max_wal_size=1GB`, `checkpoint_timeout=5min`, `track_counts=on`, and
`track_io_timing=off`. Autovacuum is enabled with three workers and the default
20% vacuum / 10% analyze scale factors. The only installed extension is
`plpgsql`. The sole application-independent sequence is the 8 KiB Drizzle
migration sequence; application keys are UUIDs or text.

Material relations at the audit snapshot:

| Table | Total bytes | Heap bytes | Index bytes | TOAST bytes | Estimated live rows |
| --- | ---: | ---: | ---: | ---: | ---: |
| `raw_irc_messages` | 2,744,344,576 | 2,341,961,728 | 395,165,696 | 6,545,408 | 3,857,793 |
| `chat_messages` | 1,073,471,488 | 530,751,488 | 542,490,624 | 65,536 | 1,815,064 |
| `chat_membership_events` | 912,916,480 | 453,124,096 | 459,636,736 | 8,192 | 1,815,816 |
| `stream_snapshots` | 578,183,168 | 387,563,520 | 190,480,384 | 8,192 | 1,167,894 |
| `raw_helix_responses` | 525,148,160 | 47,685,632 | 2,080,768 | 475,340,800 | 46,936 |
| `chatter_channel_activity_buckets` | 212,336,640 | 137,379,840 | 74,883,072 | 8,192 | 793,055 |
| `stream_activity_buckets` | 191,791,104 | 130,433,024 | 61,292,544 | 8,192 | 721,685 |
| `ingestion_runs` | 156,196,864 | 149,053,440 | 7,069,696 | 8,192 | 165,656 |
| `raw_eventsub_events` | 57,704,448 | 46,415,872 | 11,239,424 | 8,192 | 52,187 |
| `channel_events` | 45,342,720 | 15,671,296 | 29,630,464 | 8,192 | 82,975 |
| `eventsub_subscriptions` | 43,466,752 | 12,460,032 | 30,965,760 | 8,192 | 36,936 |
| `rate_limit_observations` | 40,730,624 | 38,576,128 | 2,105,344 | 8,192 | 46,855 |
| `chat_assignment_events` | 40,697,856 | 33,554,432 | 7,094,272 | 8,192 | 169,709 |
| `chatter_daily_stats` | 25,231,360 | 18,407,424 | 6,782,976 | 8,192 | 121,191 |
| `stream_sessions` | 12,378,112 | 6,119,424 | 6,217,728 | 8,192 | 23,550 |
| `twitch_users` | 9,822,208 | 6,545,408 | 3,235,840 | 8,192 | 42,257 |
| `chat_assignments` | 8,921,088 | 4,268,032 | 4,612,096 | 8,192 | 21,477 |
| `channel_daily_stats` | 4,317,184 | 3,219,456 | 1,056,768 | 8,192 | 18,139 |

All other individual relations were below 2 MB. The five raw/detail tables at
the top account for about 87% of public relation storage. `raw_helix_responses`
is almost entirely TOASTed response JSON. Indexes are also a first-order cost:
the normalized chat and membership tables each have as many index bytes as heap
bytes.

No exact duplicate indexes were found. Large zero-scan indexes over the
August 14 to September 2 statistics lifetime are review candidates, not approved
drop targets:

- `raw_irc_messages_channel_received_idx`: 177,782,784 bytes.
- `chat_membership_events_channel_received_idx`: 89,399,296 bytes.
- `eventsub_subscriptions_status_idx`: 20,742,144 bytes.
- `channel_events_source_event_idx`: 7,036,928 bytes.
- `channel_events_channel_occurred_idx`: 4,898,816 bytes.

Primary and unique indexes with zero scans still enforce identity or
deduplication and are not unused-index candidates. Query plans and a longer
post-deployment statistics window are required before dropping any index.

## Ingest rate, duplication, and write amplification

All major tables begin on August 14, so the configured 30-day raw retention
window has not yet reached any row. The maintenance heartbeat is healthy and
reported zero rows redacted in all four raw categories. The latest seven full
UTC days averaged:

| Table | Rows/week | Rows/day |
| --- | ---: | ---: |
| `raw_irc_messages` | 1,398,371 | 199,767 |
| `chat_messages` | 661,773 | 94,539 |
| `chat_membership_events` | 656,515 | 93,788 |
| `stream_snapshots` | 437,674 | 62,525 |
| `raw_helix_responses` | 17,817 | 2,545 |
| `raw_eventsub_events` | 15,198 | 2,171 |
| `ingestion_runs` | about 61,824 | 8,832 |

The detailed follow-up found that only 11,080 of 440,531 snapshots in the
latest seven days (2.52%) were either the first sample for a stream or contained
a descriptive metadata change. Viewer counts are still distinct observations;
the repeated title/category/tag/thumbnail payload is not.

The 46,936 raw Helix rows included 16,037 `/users` responses containing about
220 MB of response JSON and 25,622 `/streams` responses containing about 206 MB.
The user payloads were being refetched for every live broadcaster on every
three-minute discovery pass even though the normalized user row is overwritten,
not versioned.

There were 165,820 ingestion-run rows: 165,818 successes and two failures.
Current loop state and full latest summaries already exist in the eight
singleton heartbeat rows, so per-interval success rows are primarily duplicate
operational telemetry.

A 1% sample of raw IRC showed about 46% `PRIVMSG`, 26% `JOIN`, and 22% `PART`.
Every sampled normalized chat and membership row linked back to a raw IRC row,
and all membership rows had a non-null unique dedupe key. Chat message IDs are a
primary key, EventSub message IDs are unique, and the structured event tables
also have conflict guards. There is no evidence of a duplicate-ingestion or
failed-upsert loop. The approximately one raw row plus one normalized row per
chat/membership observation is the intended ledger design.

Sampled logical widths explain the cost:

- Raw IRC averaged 595 bytes/row, including a 253-byte raw line and 225-byte
  parsed tags object. IRC tags are therefore present in both the raw line and
  parsed JSON, while normalized rows copy relevant text/badges/emotes again.
- Chat messages averaged 278 bytes/row, including 41 bytes of text and 55 bytes
  of badge/emote JSON.
- Membership rows averaged 234 bytes, including a 78-byte dedupe key.
- Stream snapshots averaged 322 bytes, of which about 200 bytes were repeated
  title/category/tag/thumbnail values captured every discovery poll.
- Raw Helix rows averaged about 25.5 KB logically; response JSON averaged
  9.2 KB (p50 8.0 KB, p95 20.6 KB).
- Raw EventSub rows averaged 804 bytes, including a 616-byte payload.

The largest avoidable workload is the aggregation loop. Every minute it
reprocessed 48 hours and executed unconditional conflict updates, including
`updated_at=now()`, even for completed buckets whose values had not changed.
Since August 14, the counters showed approximately:

- 3.015 billion updates to `stream_activity_buckets`.
- 2.174 billion updates to `chatter_channel_activity_buckets`.
- 347.6 million updates to `chatter_daily_stats`.
- 132.4 million updates to `channel_daily_stats`.
- 1.993 TB of generated WAL and 935.8 GB of temporary database I/O.

Assignment reconciliation also contained a permanent-failure retry loop. Of
169,709 assignment events, 20,081 were failures; the dominant errors were
permanent IRC bans. One channel alone had been retried 5,010 times. The same
failed assignment was moved back to `desired` every 30 seconds and failed again.

Autovacuum has been running and dead tuples were generally low outside the
rollups. The two large bucket tables were near 16-18% dead rows at one snapshot,
consistent with the default 20% autovacuum trigger. This is write churn and
index-amplification evidence, not proof of a multi-gigabyte reclaimable bloat
reserve. Exact bloat measurement would require additional tooling or offline
analysis. `VACUUM FULL` is unsafe on the current disk because it rewrites and
locks the table while requiring extra space.

## Product dependencies and lifecycle boundary

The current product uses durable session, structured event, raid, daily, and
five-minute aggregate tables for analytics and historical comparisons. Raw
snapshots are used for the latest live state and endpoints capped at 500 samples.
Normalized chat powers own-data totals/recent messages and the administrator
message archive. Normalized membership powers private recent chatter detail.
Raw IRC is exposed only in the private stream diagnostic endpoint and is joined
through nullable raw-row foreign keys. Raw Helix payloads are not queried by the
product after normalization.

Any future raw-ledger deletion would require dependency ordering:

- `raw_irc_messages` is referenced by chat messages, membership events, channel
  events, and room-state events.
- `raw_eventsub_events` is referenced by chat messages, channel events, and raids.
- `raw_helix_responses` references ingestion runs but has no product child table.
- Snapshot deletion has no child foreign key, but affects recent raw charts.

The preservation-first baseline is documented in the
[storage and backup lifecycle](../runbooks/storage-and-backup-lifecycle.md).
It retains messages, membership, viewer observations, raw IRC wire data, raw
EventSub payloads, structured history, and aggregates indefinitely. Space
savings come from removing duplicate encodings and repeated writes rather than
age-based deletion. No production cleanup was applied during the evidence
collection phase of this audit.

## Forecast and thresholds

At current workload, public relations have grown roughly 0.33-0.35 GB/day. The
compressed dump grows about 0.075 GB/day. With the old approximately 15-dump
window, each new dump soon replaces a dump roughly 15 days smaller, so retained
backup bytes rise about 1.1 GB/day while the database adds another 0.34 GB/day.
The root filesystem would cross 90% in roughly five days and exhaust available
space in roughly eight days if those rates continued.

Even if future dumps stayed fixed at today's 1.344 GB, 15 retained copies would
converge near 20.2 GB. Under the observed linear dump trend, the 15 newest dumps
would total about 28.1 GB in another two weeks. A seven-copy cap on the same disk
slows but does not solve growth: backup bytes would still rise about 0.53 GB/day
as the database grows, in addition to database relation growth.

Use 80% filesystem usage as warning and 90% as critical, with a 5 GiB minimum
free-space reserve plus one previous-dump-sized allowance before beginning a new
dump. Moving verified backups off the root disk removes the immediate backup
multiplier, but unbounded database detail would still reach 90% in about three
weeks from this snapshot unless old backup bytes are also removed or the disk is
expanded. These are linear planning estimates; alert on measured deltas rather
than treating them as guarantees.

No age-based deletion is recommended. The immediate production-safe savings
are a one-copy local backup rotation (about 11 GB at this snapshot), removal of
roughly 300 MB of unused indexes, no-op aggregation guards, permanent-failure
suppression, hourly success telemetry, daily broadcaster metadata hydration,
lossless omission of parsed IRC tag copies, meaning-preserving omission of
JOIN/PART wire duplicates, and
change-only snapshot metadata. Existing-row compaction is a separate operation:
ordinary vacuum makes rewritten pages reusable but does not guarantee that the
relation files shrink at the host level.
