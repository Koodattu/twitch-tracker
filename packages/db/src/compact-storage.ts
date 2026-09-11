import { parseArgs } from "node:util";
import { createPgPool } from "./index.js";

const { values } = parseArgs({ options: {
  apply: { type: "boolean", default: false },
  database: { type: "string" },
  before: { type: "string" }
} });
const connectionString = process.env.DATABASE_URL;
if (connectionString == null) throw new Error("DATABASE_URL is required.");
const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
if (values.database !== databaseName) throw new Error("Pass --database with the exact target database name.");
const before = values.before == null ? new Date(Date.now() - 86_400_000) : new Date(values.before);
if (Number.isNaN(before.getTime())) throw new Error("--before must be a valid timestamp.");
const pool = createPgPool(connectionString);
const client = await pool.connect();
try {
  await client.query("set statement_timeout = '120s'");
  await client.query("set lock_timeout = '2s'");
  const eligible = await client.query<{ count: string }>(`select count(*) as count from raw_irc_messages
    where payload_block_id is null and raw_line <> '' and received_at < $1`, [before]);
  console.log(JSON.stringify({ database: databaseName, before: before.toISOString(), eligible: Number(eligible.rows[0]!.count), apply: values.apply }));
  if (values.apply) {
    let total = 0;
    for (;;) {
      const result = await client.query<{ count: number }>(`select sum(compact_raw_irc_batch($1, 256))::int as count
        from generate_series(1, 20)`, [before]);
      const count = result.rows[0]!.count;
      total += count;
      if (count === 0 || total % 51200 === 0) console.log(JSON.stringify({ compacted: total }));
      if (count === 0) break;
    }
    const remaining = await client.query<{ count: string }>(`select count(*) as count from raw_irc_messages
      where payload_block_id is null and raw_line <> '' and received_at < $1`, [before]);
    if (remaining.rows[0]!.count !== "0") throw new Error("Eligible IRC rows remain locked or were inserted concurrently; rerun compaction with the same cutoff.");
  }
} finally {
  client.release();
  await pool.end();
}
