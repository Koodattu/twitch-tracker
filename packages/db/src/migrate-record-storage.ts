import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createPgPool } from "./index.js";

// Existing installations use table-sized transactions. drizzle-kit wraps all
// pending files in one transaction, retaining every old heap until the end.
const { values } = parseArgs({ options: { database: { type:"string" }, apply: { type:"boolean", default:false } } });
const connectionString=process.env.DATABASE_URL;
if (connectionString==null) throw new Error("DATABASE_URL is required.");
const database=decodeURIComponent(new URL(connectionString).pathname.slice(1));
if (values.database!==database) throw new Error("Pass --database with the exact target database name.");
const journal=JSON.parse(await readFile(new URL("../migrations/meta/_journal.json",import.meta.url),"utf8")) as {
  entries:Array<{idx:number;when:number;tag:string}>;
};
const phases=await Promise.all(journal.entries.filter(e=>e.idx>=24 && e.idx<=28).map(async entry=>{
  const source=await readFile(new URL(`../migrations/${entry.tag}.sql`,import.meta.url),"utf8");
  return {...entry,source,hash:createHash("sha256").update(source).digest("hex")};
}));
if (phases.length!==5) throw new Error("Expected the complete storage migration package.");
const pool=createPgPool(connectionString), client=await pool.connect();
try {
  await client.query("set lock_timeout='5s'");
  await client.query("set statement_timeout='30min'");
  if (!(await client.query("select pg_try_advisory_lock(20261010,24) as acquired")).rows[0].acquired) throw new Error("Another storage migration is running.");
  const applied=(await client.query<{hash:string;created_at:string}>("select hash,created_at::text from drizzle.__drizzle_migrations order by created_at")).rows;
  const latest=Number(applied.at(-1)?.created_at);
  if (latest!==1790658001000 && !phases.some(p=>p.when===latest)) throw new Error("Expected migration 0023 or a storage migration checkpoint; inspect the database version.");
  for (const phase of phases) {
    const previous=applied.find(m=>Number(m.created_at)===phase.when);
    if (previous!=null && previous.hash!==phase.hash) throw new Error(`Applied migration ${phase.tag} has a different checksum.`);
    if (phase.when<=latest && previous==null) throw new Error(`Missing migration checkpoint ${phase.tag}.`);
  }
  const pending=phases.filter(p=>p.when>latest);
  const sizes=(await client.query(`select relname,pg_total_relation_size(relid)::text as bytes from pg_stat_user_tables
    where relname in ('chat_messages','chat_message_records','stream_snapshots','stream_snapshot_records','raw_irc_messages','raw_irc_records','stream_activity_buckets','twitch_users','stream_sessions') order by relname`)).rows;
  console.log(JSON.stringify({database,apply:values.apply,pending:pending.map(p=>p.tag),sizes,
    requires:"Stop API and worker writes; verify backup, canonical baseline, and disk/WAL headroom before --apply."}));
  if (values.apply) for (const phase of pending) {
    const start=Date.now();
    await client.query("begin");
    try {
      await client.query(phase.source);
      await client.query("insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)",[phase.hash,phase.when]);
      await client.query("commit");
      console.log(JSON.stringify({completed:phase.tag,elapsedMs:Date.now()-start}));
    } catch (error) {
      await client.query("rollback");
      console.error(`Rolled back ${phase.tag}. Earlier checkpoints remain committed; keep the application stopped and resume with the same command.`);
      throw error;
    }
  }
} catch (error) {
  // Driver details can include observation values; keep operational output safe.
  console.error(error instanceof Error ? error.message : "Storage migration failed.");
  process.exitCode=1;
} finally {
  await client.query("select pg_advisory_unlock(20261010,24)");
  client.release();await pool.end();
}
