import { createDb } from "./index.js";
import { rollupExpiredMembership } from "./membership-retention.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const expected = process.argv[process.argv.indexOf("--database") + 1];
if (!process.argv.includes("--database") || decodeURIComponent(new URL(url).pathname.slice(1)) !== expected) {
  throw new Error("Pass --database with the exact database name");
}
if (!process.argv.includes("--apply")) throw new Error("--apply is required: this converts expired membership events into summaries");
const { db, pool } = createDb(url);
try {
  let events = 0;
  let contexts = 0;
  while (true) {
    const result = await rollupExpiredMembership(db, 100);
    events += result.events;
    contexts += result.contexts;
    console.log(JSON.stringify({ ...result, totalEvents: events, totalContexts: contexts }));
    if (result.contexts < 100) break;
  }
} finally { await pool.end(); }
