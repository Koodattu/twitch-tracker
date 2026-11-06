import { createDb } from "./index.js";
import { expireChatWire } from "./chat-retention.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const expected = process.argv[process.argv.indexOf("--database") + 1];
if (!process.argv.includes("--database") || decodeURIComponent(new URL(url).pathname.slice(1)) !== expected) {
  throw new Error("Pass --database with the exact database name");
}
if (!process.argv.includes("--apply")) throw new Error("--apply is required: this expires normalized raw chat copies older than 30 complete days");
const batchIndex = process.argv.indexOf("--batch-size");
const batchSize = batchIndex < 0 ? 1000 : Number(process.argv[batchIndex + 1]);
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) throw new Error("--batch-size must be between 1 and 5000");
const { db, pool } = createDb(url);
try {
  let total = 0;
  while (true) {
    const expired = await expireChatWire(db, batchSize);
    total += expired;
    console.log(JSON.stringify({ expired, total }));
    if (expired === 0) break;
  }
} finally { await pool.end(); }
