# Retire unused chatter summaries and index pending identities

Migrations 0022 and 0023 remove an unread materialization and move the membership
pending-work index to the identity records that actually carry resolution state.
Chat messages, raw IRC, membership events, stream buckets and daily statistics
retain their formats and contents. No source-event retention limit is introduced.

## Removed materialization

`chatter_channel_activity_buckets` had no product reader. Daily statistics and
community analysis query source observations directly; stream/channel timelines
use `stream_activity_buckets`, which remains. The removed worker query repeatedly
aggregated a 48-hour window of message and membership observations.

On the September 29 production copy, all 6,365,171 materialized rows had matching
source activity; none contained independent emote/badge metadata. Migration 0022
refuses to proceed if any nonempty emote/badge summaries exist. Activity metrics
can be rebuilt from the retained source observations. The table's maintenance
`created_at`/`updated_at` values are retired, along with potentially stale derived
totals; the pre-migration table dump preserves the exact previous materialization
for rollback. This is not a claim that maintenance timestamps are reconstructible.

The production table occupied about 1.33 GB and recently grew about 46 MB/day.
Freshly restored copies are smaller because they do not include production bloat.

## Pending membership lookup

Resolved cohorts leave event `identity_time_kind` values unchanged. An event-only
partial index therefore continued accumulating resolved history. Migration 0023
replaces it with a partial identity index, preserving immutable historical
identities as well as open cohorts. The worker still considers only unchecked
events in the last 24 hours, takes the oldest 10,000 observations, and requests up
to 100 distinct logins. Identity-table vacuum/analyze thresholds become 2% to
limit dead-row accumulation from cohort resolution.

## Validation and rollout

1. Stream a consistent production dump into a fresh local PostgreSQL container;
   retain its checksum and untouched baseline. Create a separate release copy.
2. Verify every existing chatter bucket has source activity and inspect any
   differing totals before retirement. Run all migrations and integration tests
   against a dedicated test database. Compare all retained physical-table row
   fingerprints between baseline and release, with consistent UTC/ISO formatting.
3. Compare actual pending-identity queries and representative application reads.
   Include dictionaries and indexes in any proposed layout measurement.
4. Dump the retired table separately from the baseline. Restore a migrated copy,
   restore that table, and run the reverse SQL below. Compare its exact contents
   and all retained source tables with the baseline.
5. Require CI for the exact release commit. Hold the VM's shared deployment lock,
   guard Twitch's automatic deployment with its established maintenance-branch
   procedure, and build matching images before stopping writers. Keep prior images.
6. Stop API/worker/backup writers; take fresh off-host full and table-specific
   backups. Compare retained-table fingerprints before and after the normal
   migration image. Restart matching services, verify ingestion and endpoints,
   create a verified backup, and restore automatic deployment from main.

No table rewrite or VACUUM FULL is required. A short writer pause is still needed
to prevent the old aggregation worker from querying the retired table and to
obtain a stable verification point; live IRC observations may be missed then.

## Rollback

Stop writers. Restore only `chatter_channel_activity_buckets` from the dedicated
pre-migration dump using `pg_restore --exit-on-error --no-owner --no-privileges`.
Then apply `packages/db/online-migrations/0024_restore_retired_chatter_rollups.sql`
and restart the previous application images. The reverse SQL requires 0023 to be
the latest migration and removes restored summaries for already deleted subjects.
If the new release has run longer than the aggregation lookback, historical
summary repair is required for that interval. Do not restore the entire old
database over subsequently collected source observations.

## Chat normalization experiment

A local prototype reduced chat storage from 2.799 GB to 2.323 GB, including its
identity/context dictionaries and all indexes (about 17%). The same-snapshot read
benchmark exposed unacceptable regressions: a heavily active chatter's history
query rose from about 0.1 ms to 313 ms, and a channel query from 198 ms to 497 ms.
These are local measurements, not production latency forecasts. The prototype
was rejected and is not part of this migration; a future design must preserve
efficient ordered user/channel/stream access before deployment.
