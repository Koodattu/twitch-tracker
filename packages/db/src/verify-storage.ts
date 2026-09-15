import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createPgPool } from "./index.js";

const { values } = parseArgs({ options: {
  database: { type: "string" },
  layout: { type: "string", default: "compact" },
  compare: { type: "string" }
} });
const connectionString = process.env.DATABASE_URL;
if (connectionString == null) throw new Error("DATABASE_URL is required.");
const databaseName = decodeURIComponent(new URL(connectionString).pathname.slice(1));
if (values.database !== databaseName) throw new Error("Pass --database with the exact target database name.");
if (values.layout !== "inline" && values.layout !== "compact" && values.layout !== "metadata") throw new Error("--layout must be inline, compact or metadata.");
type Fingerprint = { rows: string; hash1: string | null; hash2: string | null };
const expected = values.compare == null ? null : JSON.parse(await readFile(values.compare, "utf8")) as { fingerprints: Record<string, Fingerprint> };
const pool = createPgPool(connectionString);
const client = await pool.connect();
try {
  await client.query("begin isolation level repeatable read read only");
  await client.query("set local lock_timeout = '5s'");
  await client.query("set local statement_timeout = '30min'");
  await client.query("set local work_mem = '256MB'");
  await client.query("set local time zone 'UTC'");
  // Array expansion is underestimated by the planner; avoid sorting millions of wire lines.
  await client.query("set local enable_mergejoin = off");
  const sizes = (await client.query(`select relname, pg_total_relation_size(relid)::text as total
    from pg_stat_user_tables order by relname`)).rows;
  const databaseBytes = (await client.query("select pg_database_size(current_database())::text as bytes")).rows[0].bytes as string;
  const fingerprints: Record<string, Fingerprint> = {};
  const metadata = (await client.query("select to_regprocedure('decode_compact_json(bytea)') is not null as compact")).rows[0].compact as boolean;
  const derivedKeys = (await client.query("select exists(select 1 from pg_attribute where attrelid='chat_membership_events'::regclass and attname='dedupe_key_storage' and not attisdropped) as enabled")).rows[0].enabled as boolean;
  const sharedContexts = (await client.query("select to_regclass('raw_irc_contexts') is not null as enabled")).rows[0].enabled as boolean;
  const tables = ["raw_irc_messages", "chat_messages", "chat_membership_events", "stream_snapshots"];
  if (values.layout === "metadata") tables.push("raw_irc_payload_blocks");
  for (const table of tables) {
    const compact = values.layout !== "inline";
    const raw = values.layout === "compact" && table === "raw_irc_messages";
    let row = "to_jsonb(r)";
    if (sharedContexts && table === "raw_irc_messages") row = "(to_jsonb(r)-'context_id') || jsonb_build_object('channel_login',c.channel_login,'bot_account_id',c.bot_account_id,'irc_connection_id',c.irc_connection_id)";
    if (raw) row = `(${row}-'payload_block_id'-'payload_position'-'unrelayed_source') || jsonb_build_object('raw_line',case when payload_block_id is null then raw_line else expanded.wire_line end)`;
    if (compact && table === "chat_messages") row = "to_jsonb(r) || jsonb_build_object('twitch_message_id',decode_chat_message_id(twitch_message_id),'reply_parent_message_id',decode_chat_message_id(reply_parent_message_id))";
    if (compact && table === "chat_membership_events") {
      const key = derivedKeys ? "read_membership_key(broadcaster_user_id,twitch_stream_id,event_type,chatter_login,event_at,dedupe_key_storage)" : "dedupe_key";
      row = `(to_jsonb(r)-'dedupe_key_storage') || jsonb_build_object('dedupe_key',translate(rtrim(encode(${key},'base64'),'='),'+/','-_'))`;
    }
    if (metadata && table === "raw_irc_messages") row = `(${row}) || jsonb_build_object('tags',decode_compact_json(tags),'parsed_command',decode_common_label(parsed_command,'PRIVMSG'))`;
    if (metadata && table === "chat_messages") row = `(${row}) || jsonb_build_object('badges',decode_compact_json(badges),'emotes',decode_compact_json(emotes))`;
    if (metadata && table === "chat_membership_events") row = `(${row}) || jsonb_build_object('source',decode_common_label(source,'irc_membership'))`;
    const prefix = raw ? "with expanded as materialized (select id, slot, wire_line from raw_irc_payload_blocks cross join lateral unnest(lines) with ordinality as expanded(wire_line,slot)), " : "with ";
    const join = (raw ? " left join expanded on expanded.id=r.payload_block_id and expanded.slot=r.payload_position" : "")
      + (sharedContexts && table === "raw_irc_messages" ? " left join raw_irc_contexts c on c.id=r.context_id" : "");
    const cache = raw ? ", payload_block_id is not null and (expanded.wire_line is null or unrelayed_source is distinct from (expanded.wire_line like '@%' and split_part(expanded.wire_line, ' ', 1) !~ '(?:^@|;)source-room-id=[^;]+')) as cache_mismatch" : "";
    const check = raw ? ", count(*) filter(where cache_mismatch)::text as cache_errors" : "";
    const checked = (await client.query(`${prefix}hashes as materialized (
      select md5((${row})::text) as hash${cache} from ${table} r${join}
    ) select count(*)::text as rows,
      sum(('x'||substr(hash,1,16))::bit(64)::bigint::numeric)::text as hash1,
      sum(('x'||substr(hash,17,16))::bit(64)::bigint::numeric)::text as hash2${check} from hashes`)).rows[0];
    if (raw) {
      if (checked.cache_errors !== "0") throw new Error("Raw payloads or source-attribution cache differ.");
      delete checked.cache_errors;
    }
    fingerprints[table] = checked;
    console.error(`Verified ${table}: ${checked.rows} rows`);
  }
  await client.query("commit");
  const matchesBaseline = expected == null ? null : Object.entries(fingerprints).every(([table, actual]) =>
    actual.rows === expected.fingerprints[table]?.rows && actual.hash1 === expected.fingerprints[table]?.hash1 && actual.hash2 === expected.fingerprints[table]?.hash2);
  console.log(JSON.stringify({ databaseName, layout: values.layout, databaseBytes, sizes, fingerprints, matchesBaseline }, null, 2));
  if (matchesBaseline === false) throw new Error("Canonical row fingerprints differ from the baseline.");
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
