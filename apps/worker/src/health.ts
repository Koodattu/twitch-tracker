import { createPgPool } from "@twitch-tracker/db";
import { readFileSync } from "node:fs";

const databaseUrl = process.env.DATABASE_URL
  ?? (process.env.DATABASE_URL_FILE == null ? undefined : readFileSync(process.env.DATABASE_URL_FILE, "utf8").trimEnd());
if (databaseUrl == null || databaseUrl === "") {
  throw new Error("DATABASE_URL is required for the worker health check.");
}

const workerName = process.env.WORKER_NAME ?? "worker-1";
const maxAgeMs = Number(process.env.WORKER_HEALTH_MAX_AGE_MS ?? 900_000);
const expectedLoopCount = Number(process.env.WORKER_EXPECTED_LOOP_COUNT ?? 8);
const pool = createPgPool(databaseUrl);

try {
  const result = await pool.query<{ loop_count: number; all_fresh: boolean }>(
    `select count(*)::int as loop_count,
            coalesce(bool_and(last_heartbeat_at >= now() - ($2::bigint * interval '1 millisecond')), false) as all_fresh
       from worker_heartbeats
      where worker_name = $1`,
    [workerName, maxAgeMs]
  );
  const health = result.rows[0];
  if (health == null || health.loop_count < expectedLoopCount || !health.all_fresh) {
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
