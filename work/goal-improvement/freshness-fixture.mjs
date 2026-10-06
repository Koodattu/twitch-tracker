// Disposable UI database only; restore with fixture.mjs seed after inspection.
import { createRequire } from "node:module";
import { fixtureUrl } from "./fixture.mjs";
const { Pool } = createRequire(new URL("../../packages/db/package.json", import.meta.url))("pg");
const pool = new Pool({ connectionString: fixtureUrl });
const mode = process.argv[2] ?? "mixed";
if (!["mixed", "stale", "fresh", "missing", "empty"].includes(mode)) throw new Error("Unknown freshness scene.");
try {
  const now = Date.now();
  for (const [index, identity] of ["aurora", "sisu", "kettu", "lumi"].entries()) {
    const stream = `goal-${identity}-0`;
    const old = mode === "stale" || (mode === "mixed" && identity === "sisu");
    const seen = new Date(now - (old ? 3 * 3_600_000 : 120_000));
    await pool.query("update stream_sessions set started_at=$2, first_seen_at=$2, last_seen_live_at=$3, ended_at=$4 where twitch_stream_id=$1", [stream, new Date(now - 4 * 3_600_000), seen, mode === "empty" ? seen : null]);
    await pool.query("delete from stream_snapshots where twitch_stream_id=$1", [stream]);
    if (mode !== "missing" && !(mode === "mixed" && identity === "kettu")) {
      await pool.query(`insert into stream_snapshots(twitch_stream_id,broadcaster_user_id,observed_at,viewer_count,title,category_name)
        values($1,$2,$3,$4,'Synthetic freshness observation','Just Chatting')`, [stream, `goal-${identity}`, seen, index === 3 ? 0 : (index + 1) * 100]);
    }
  }
  console.log(`Freshness scene: ${mode}. Synthetic UI database only.`);
} finally { await pool.end(); }
