\pset pager off
\echo 'PostgreSQL storage report (metadata and aggregates only)'

begin read only;
set local statement_timeout = '120s';
set local lock_timeout = '2s';

select now() as observed_at,
       version(),
       pg_postmaster_start_time() as postmaster_started_at,
       pg_database_size(current_database()) as database_bytes,
       pg_size_pretty(pg_database_size(current_database())) as database_size;

select name, setting, unit
from pg_settings
where name in (
  'server_version',
  'block_size',
  'wal_level',
  'max_wal_size',
  'checkpoint_timeout',
  'autovacuum',
  'autovacuum_max_workers',
  'autovacuum_naptime',
  'autovacuum_vacuum_scale_factor',
  'autovacuum_vacuum_threshold',
  'autovacuum_analyze_scale_factor',
  'autovacuum_analyze_threshold',
  'track_counts',
  'track_io_timing'
)
order by name;

select schemaname,
       relname as table_name,
       pg_total_relation_size(relid) as total_bytes,
       pg_relation_size(relid) as heap_bytes,
       pg_indexes_size(relid) as index_bytes,
       n_live_tup as estimated_live_rows,
       n_dead_tup as estimated_dead_rows,
       n_mod_since_analyze,
       seq_scan,
       idx_scan,
       n_tup_ins,
       n_tup_upd,
       n_tup_del,
       n_tup_hot_upd,
       last_autovacuum,
       last_autoanalyze
from pg_stat_user_tables
order by pg_total_relation_size(relid) desc;

select schemaname,
       relname as table_name,
       indexrelname as index_name,
       pg_relation_size(indexrelid) as index_bytes,
       idx_scan,
       idx_tup_read,
       idx_tup_fetch
from pg_stat_user_indexes
order by pg_relation_size(indexrelid) desc;

select n.nspname as schema_name,
       c.relname as table_name,
       tc.relname as toast_table,
       pg_relation_size(tc.oid) as toast_heap_bytes,
       pg_indexes_size(tc.oid) as toast_index_bytes,
       pg_total_relation_size(tc.oid) as toast_total_bytes
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_class tc on tc.oid = c.reltoastrelid
where n.nspname not in ('pg_catalog', 'information_schema')
order by pg_total_relation_size(tc.oid) desc;

select wal_records,
       wal_fpi,
       wal_bytes,
       wal_buffers_full,
       stats_reset
from pg_stat_wal;

select datname,
       stats_reset,
       temp_files,
       temp_bytes,
       deadlocks,
       checksum_failures
from pg_stat_database
where datname = current_database();

with daily as (
  select 'raw_irc_messages'::text as table_name,
         date_trunc('day', received_at) as day,
         count(*)::bigint as rows
  from raw_irc_messages
  where received_at >= current_date - interval '14 days'
  group by 1, 2
  union all
  select 'chat_messages', date_trunc('day', received_at), count(*)
  from chat_messages
  where received_at >= current_date - interval '14 days'
  group by 1, 2
  union all
  select 'chat_membership_events', date_trunc('day', received_at), count(*)
  from chat_membership_events
  where received_at >= current_date - interval '14 days'
  group by 1, 2
  union all
  select 'stream_snapshots', date_trunc('day', observed_at), count(*)
  from stream_snapshots
  where observed_at >= current_date - interval '14 days'
  group by 1, 2
  union all
  select 'raw_helix_responses', date_trunc('day', observed_at), count(*)
  from raw_helix_responses
  where observed_at >= current_date - interval '14 days'
  group by 1, 2
  union all
  select 'raw_eventsub_events', date_trunc('day', received_at), count(*)
  from raw_eventsub_events
  where received_at >= current_date - interval '14 days'
  group by 1, 2
)
select table_name, day, rows
from daily
order by table_name, day;

commit;
