-- Read-only, aggregate/catalog-only input to the native-row width audit.
-- Run with default_transaction_read_only=on and short statement/lock timeouts.
BEGIN READ ONLY;
SELECT jsonb_build_object(
  'captured_at', clock_timestamp(),
  'version', version(),
  'database_bytes', pg_database_size(current_database()),
  'relations', (SELECT jsonb_agg(jsonb_build_object(
    'name', c.relname, 'estimated_rows', c.reltuples,
    'heap_bytes', pg_relation_size(c.oid),
    'table_bytes', pg_table_size(c.oid),
    'index_bytes', pg_indexes_size(c.oid),
    'total_bytes', pg_total_relation_size(c.oid),
    'live_rows_estimate', s.n_live_tup, 'dead_rows_estimate', s.n_dead_tup,
    'last_analyze', greatest(s.last_analyze,s.last_autoanalyze)
  ) ORDER BY pg_total_relation_size(c.oid) DESC)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
  WHERE n.nspname='public' AND c.relkind='r'),
  'indexes', (SELECT jsonb_agg(jsonb_build_object(
    'table', t.relname, 'name', c.relname,
    'bytes', pg_relation_size(c.oid), 'definition', pg_get_indexdef(c.oid)
  ) ORDER BY t.relname,c.relname)
  FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
  JOIN pg_class t ON t.oid=i.indrelid
  JOIN pg_namespace n ON n.oid=t.relnamespace
  WHERE n.nspname='public'),
  'columns', (SELECT jsonb_agg(jsonb_build_object(
    'table', c.relname, 'position', a.attnum, 'name', a.attname,
    'type', format_type(a.atttypid,a.atttypmod), 'dropped', a.attisdropped,
    'avg_width', s.avg_width, 'null_fraction', s.null_frac,
    'distinct_estimate', s.n_distinct
  ) ORDER BY c.relname,a.attnum)
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
  LEFT JOIN pg_stats s ON s.schemaname=n.nspname AND s.tablename=c.relname AND s.attname=a.attname
  WHERE n.nspname='public' AND c.relkind='r')
);
COMMIT;
