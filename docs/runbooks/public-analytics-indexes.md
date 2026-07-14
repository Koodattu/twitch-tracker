# Public analytics indexes

The public analytics indexes are kept out of the normal Drizzle migration path
because PostgreSQL does not allow `CREATE INDEX CONCURRENTLY` inside a
transaction. Drizzle's PostgreSQL migrator wraps migration files in a
transaction, while plain `CREATE INDEX` can block crawler writes for the full
index build on a populated database.

Apply the online index file directly with `psql` before relying on the optimized
query plans in production:

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/online-migrations/0009_public_analytics_indexes.sql
```

Run this once per database. Successful statements can be rerun without
rebuilding their indexes and build without blocking normal reads or writes,
although they still consume database CPU, I/O, and temporary disk. Do not wrap
the file in an explicit transaction. Monitor database load and free disk space
during the build.

The final query must list all eight indexes with both `indisready` and
`indisvalid` set to `t`. A failed concurrent build can leave an invalid index
with the expected name; `IF NOT EXISTS` will skip that index on a retry. Drop
only the invalid index outside a transaction, then rerun the file:

```sql
DROP INDEX CONCURRENTLY IF EXISTS "replace_with_invalid_index_name";
```

Afterward, use `EXPLAIN (ANALYZE, BUFFERS)` with representative data to confirm
that live discovery, recently ended sessions, channel history, assignments,
events, and raids use the intended indexes.
