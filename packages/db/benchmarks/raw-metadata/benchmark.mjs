import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';

// Deliberately outside src/, normal migrations, and the application's test discovery.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const { values } = parseArgs({ options: { name: { type: 'string' }, rows: { type: 'string', default: '30000' }, sample: { type: 'string' } } });
const run = values.name;
assert.match(run ?? '', /^[a-z][a-z0-9_]{0,25}$/, 'Pass a new --name containing lowercase letters, digits and underscores');
const url = new URL(process.env.BENCH_DATABASE_URL ?? 'postgres://benchmark@127.0.0.1:55436/raw_metadata_benchmark');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname === '/raw_metadata_benchmark', 'Only the dedicated local benchmark database is allowed');
const pool = new pg.Pool({ connectionString: url.toString(), max: 4, options: '-c statement_timeout=30000 -c lock_timeout=3000 -c timezone=UTC -c jit=off' });
const source = `b_${run}_input`;
const schemas = [`b_${run}_base`, `b_${run}_candidate`];
const cutoff = '2026-10-04 00:00:00+00';
const uuid = (value) => {
  const hex = createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const timestamp = (ms, micros = 0) => new Date(ms).toISOString().replace(/Z$/, `${String(micros).padStart(3, '0')}Z`);
const synthetic = (count) => Array.from({ length: count }, (_, i) => {
  const contextId = i % 5 === 0 ? 1 + i % 80 : 1 + i % 4;
  const epoch = Date.parse(['2026-08-20T17:00:00Z','2026-09-05T04:00:00Z','2026-09-21T17:00:00Z','2026-10-02T04:00:00Z'][Math.min(3, Math.floor(i / (count / 4)))]);
  // Historical cohorts, quiet/busy contexts, equal timestamps, and 2.5% recent hot rows.
  const ms = i >= count * 0.975 ? Date.parse('2026-10-04T12:00:00Z') + i * 37 : epoch + Math.floor(i / 4) * 173;
  const received = timestamp(ms, i % 9 === 0 ? 123 : 0);
  const command = i % 101 === 0 ? '!JOIN' : i % 103 === 0 ? '!PART' : '';
  const words = Array.from({ length: 16 }, (_, n) => createHash('sha256').update(`${i}:${n % 7}`).digest('hex').slice(0, 6)).join(' ');
  const line = i % 919 === 0 ? '' : command !== '' ? `:person${i % 1000}!person@host ${command.slice(1)} #room${contextId}`
    : `@badge-info=subscriber/2;badges=subscriber/0;color=#AB1234;display-name=person${i % 1000};emotes=;id=${uuid(`msg${i}`)};mod=0;${i % 11 === 0 ? 'source-room-id=other;' : ''}room-id=${contextId};subscriber=1;tmi-sent-ts=${ms};user-id=${i % 1000};user-type= :person${i % 1000}!person@host PRIVMSG #room${contextId} :Hei ääkköset 😀 ${words}`;
  return { id: uuid(`raw${i}`), raw_line: line, parsed_command: i % 809 === 0 ? null : command,
    tags_hex: i % 503 === 0 ? '027b2272617265223a22c3a4c3a4f09f9880227d' : '00', received_at: received,
    processing_status: i % 997 === 0 ? 'failed' : i % 991 === 0 ? 'pending' : 'processed',
    parse_error: i % 997 === 0 ? 'synthetic parse exception' : null,
    created_at: timestamp(ms + 1, 456), updated_at: timestamp(ms + (i % 43 === 0 ? 850 : 1), 789),
    context_id: i % 811 === 0 ? null : contextId, cohort: i >= count * 0.975 ? 'recent_hot' : `historical_${Math.floor(i / (count / 4))}`,
    context: { id: contextId, channel_login: `room${contextId}`, bot_account_id: uuid('bot'), irc_connection_id: null } };
});
const inputColumns = 'id,raw_line,parsed_command,tags,received_at,processing_status,parse_error,created_at,updated_at,context_id';
const jsonInput = `SELECT (v->>'id')::uuid,v->>'raw_line',v->>'parsed_command',decode(v->>'tags_hex','hex'),
  (v->>'received_at')::timestamptz,v->>'processing_status',v->>'parse_error',(v->>'created_at')::timestamptz,
  (v->>'updated_at')::timestamptz,(v->>'context_id')::integer FROM jsonb_array_elements($1::jsonb) v`;
const selectInput = (schema, where = '') => `SELECT id,raw_line,parsed_command,tags,received_at,processing_status::${schema}.processing_status,parse_error,created_at,updated_at,context_id FROM ${source}.feed ${where}`;
const query = (sql, params = []) => pool.query(sql, params);
const duration = async (operation) => { const start = performance.now(); await operation(); return performance.now() - start; };
const summary = (data) => {
  const sorted = [...data].sort((a, b) => a - b);
  return { n: data.length, median_ms: sorted[Math.floor(sorted.length / 2)], p95_ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] };
};
const footprint = async (schema) => {
  const { rows } = await query(`SELECT c.relname AS relation,pg_total_relation_size(c.oid)::float8 AS total_bytes,
    pg_relation_size(c.oid)::float8 AS heap_bytes,pg_indexes_size(c.oid)::float8 AS index_bytes,
    CASE WHEN c.reltoastrelid>0 THEN pg_total_relation_size(c.reltoastrelid)::float8 ELSE 0 END AS toast_bytes
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','S') ORDER BY c.relname`, [schema]);
  return { total_bytes: rows.reduce((n, row) => n + row.total_bytes, 0), relations: rows };
};
async function insert(schema, where = '', client = pool) {
  if (schema === schemas[0]) return client.query(`INSERT INTO ${schema}.raw(${inputColumns}) ${selectInput(schema, where)}`);
  return client.query(`WITH added AS (INSERT INTO ${schema}.keys(id,received_at,context_id,parsed_command,has_inline_line)
    SELECT id,received_at,context_id,parsed_command,raw_line<>'' FROM ${source}.feed ${where} RETURNING id)
    INSERT INTO ${schema}.hot SELECT f.id,f.raw_line,f.tags,f.processing_status::${schema}.processing_status,
      f.parse_error,f.created_at,f.updated_at FROM ${source}.feed f JOIN added USING(id)`);
}
async function verify(schema) {
  const { rows } = await query(`SELECT count(*)::int AS mismatches FROM ${source}.feed f FULL JOIN ${schema}.raw r USING(id)
    WHERE ROW(f.id,f.raw_line,f.parsed_command,f.tags,f.received_at,f.processing_status,f.parse_error,f.created_at,f.updated_at,f.context_id)
    IS DISTINCT FROM ROW(r.id,${schema}.wire(r.raw_line,r.payload_block_id,r.payload_position),r.parsed_command,r.tags,r.received_at,
      r.processing_status::text,r.parse_error,r.created_at,r.updated_at,r.context_id)`);
  assert.equal(rows[0].mismatches, 0, `Full record reconstruction failed: ${schema}`);
  const cache = await query(`SELECT count(*)::int AS mismatches FROM ${schema}.raw r WHERE r.unrelayed_source IS DISTINCT FROM
    CASE WHEN r.payload_block_id IS NULL THEN NULL ELSE ${schema}.wire(r.raw_line,r.payload_block_id,r.payload_position) LIKE '@%'
    AND split_part(${schema}.wire(r.raw_line,r.payload_block_id,r.payload_position),' ',1) !~ '(?:^@|;)source-room-id=[^;]+' END`);
  assert.equal(cache.rows[0].mismatches, 0, 'Source attribution cache changed');
}
async function digest(sql, params) {
  return (await query(`SELECT md5(coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb)::text) AS digest FROM (${sql}) q`, params)).rows[0].digest;
}
async function explain(sql, params) {
  const result = (await query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
  return { ms: result['Execution Time'], hits: result.Plan['Shared Hit Blocks'], reads: result.Plan['Shared Read Blocks'], temp: result.Plan['Temp Written Blocks'] };
}
function readCases(busy, quiet, ids) {
  const cases = [];
  for (const [label, cohort] of [['busy', busy], ['quiet', quiet]]) {
    for (const [field, param] of [['twitch_stream_id', cohort.stream], ['broadcaster_user_id', cohort.channel], ['chatter_user_id', cohort.chatter]]) {
      cases.push({ name: `history_${field}_${label}`, params: [param], sql: () => `SELECT id,received_at,raw_text FROM ${source}.messages WHERE ${field}=$1 ORDER BY received_at DESC,id DESC LIMIT 51 OFFSET ${label === 'quiet' ? 0 : 50}` });
    }
    cases.push({ name: `diagnostics_stream_${label}`, params: [cohort.stream], sql: (s) => `SELECT m.id,m.received_at,m.raw_text,r.id AS raw_id,r.parsed_command
      FROM ${source}.messages m LEFT JOIN ${s}.raw r ON r.id=m.raw_irc_message_id WHERE m.twitch_stream_id=$1 ORDER BY m.received_at DESC,m.id DESC LIMIT 1000` });
  }
  cases.push({ name: 'raw_point_full_record', params: [ids[0]], sql: (s) => `SELECT to_jsonb(r),${s}.wire(raw_line,payload_block_id,payload_position) FROM ${s}.raw r WHERE id=$1` });
  cases.push({ name: 'raw_diagnostics_bulk_200', params: [ids], sql: (s) => `WITH selected AS MATERIALIZED (
      SELECT id,raw_line,payload_block_id,payload_position FROM ${s}.raw WHERE id=ANY($1::uuid[])),expanded AS MATERIALIZED (
      SELECT b.id,wire_line,slot FROM ${s}.blocks b JOIN (SELECT DISTINCT payload_block_id FROM selected WHERE payload_block_id IS NOT NULL) needed
      ON needed.payload_block_id=b.id CROSS JOIN LATERAL unnest(b.lines) WITH ORDINALITY payload(wire_line,slot))
      SELECT r.id,CASE WHEN r.payload_block_id IS NULL THEN r.raw_line ELSE e.wire_line END AS line FROM selected r
      LEFT JOIN expanded e ON e.id=r.payload_block_id AND e.slot=r.payload_position ORDER BY r.id` });
  cases.push({ name: 'community_source_attribution', params: [], sql: (s) => `WITH observed AS MATERIALIZED (
      SELECT m.chatter_user_id,m.broadcaster_user_id,m.received_at,m.twitch_stream_id IS NULL AS missing_session,
      coalesce(ss.is_finnish_eligible,false) AS finnish,
      m.shared_chat_source_channel_id IS NOT NULL AND m.shared_chat_source_channel_id<>m.broadcaster_user_id AS relayed,
      m.shared_chat_source_channel_id IS NOT NULL OR coalesce(r.unrelayed_source,r.raw_line LIKE '@%' AND split_part(r.raw_line,' ',1) !~ '(?:^@|;)source-room-id=[^;]+') AS known_source,
      NOT EXISTS(SELECT 1 FROM ${source}.privacy p WHERE p.user_id=m.chatter_user_id AND p.hidden)
      AND NOT EXISTS(SELECT 1 FROM ${source}.privacy p WHERE p.user_id=m.broadcaster_user_id AND p.hidden)
      AND NOT EXISTS(SELECT 1 FROM ${source}.bots b WHERE b.user_id=m.chatter_user_id) AS permitted
      FROM ${source}.messages m LEFT JOIN ${source}.streams ss ON ss.id=m.twitch_stream_id AND ss.channel=m.broadcaster_user_id
      LEFT JOIN ${s}.raw r ON r.id=m.raw_irc_message_id AND m.shared_chat_source_channel_id IS NULL)
      SELECT chatter_user_id,broadcaster_user_id,min(received_at),max(received_at),count(*) FROM observed
      WHERE finnish AND permitted AND known_source AND NOT relayed AND chatter_user_id IS NOT NULL
      GROUP BY chatter_user_id,broadcaster_user_id HAVING count(*)>=3 ORDER BY chatter_user_id,broadcaster_user_id` });
  cases.push({ name: 'time_index_history_page', params: [], sql: (s) => `SELECT id,received_at FROM ${s}.raw ORDER BY received_at DESC,id DESC LIMIT 51 OFFSET 100` });
  return cases;
}
async function mutationTests(report) {
  const extra = synthetic(6).map((r, i) => ({ ...r, id: uuid(`${run}:edge:${i}`), raw_line: `@id=rare :test PRIVMSG #room :edge ${i} ää 😀`, context_id: null }));
  for (const row of extra) await query(`INSERT INTO ${source}.feed(${inputColumns}) ${jsonInput}`, [JSON.stringify([row])]);
  const ids = extra.map((r) => r.id);
  for (const s of schemas) await insert(s, `WHERE id=ANY(ARRAY[${ids.map((id) => `'${id}'::uuid`).join(',')}])`);
  const checks = [];
  for (const s of schemas) {
    // Pack is rolled back first; the second connection must still read all original fields.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT ${s}.pack($1,256)`, [cutoff]);
      await verify(s);
      await client.query('ROLLBACK');
      const before = await digest(`SELECT to_jsonb(r) FROM ${s}.raw r WHERE id=ANY($1::uuid[]) ORDER BY id`, [ids]);
      await client.query('BEGIN');
      await client.query(`SELECT ${s}.pack($1,256)`, [cutoff]);
      const blockedKey = s === schemas[0] ? 'raw' : 'keys';
      assert.equal((await query(`SELECT count(*)::int AS n FROM (SELECT id FROM ${s}.${blockedKey} WHERE id=$1 FOR UPDATE SKIP LOCKED) q`, [ids[0]])).rows[0].n, 0);
      assert.equal((await query(`SELECT ${s}.pack($1,256) AS n`, [cutoff])).rows[0].n, 0, 'Second packer must skip locked observations');
      await client.query('ROLLBACK');
      assert.equal(await digest(`SELECT to_jsonb(r) FROM ${s}.raw r WHERE id=ANY($1::uuid[]) ORDER BY id`, [ids]), before);
      await query(`SELECT ${s}.pack($1,256)`, [cutoff]);
    } finally { await client.query('ROLLBACK'); client.release(); }
    checks.push(`${s.endsWith('candidate') ? 'candidate' : 'baseline'}: rollback, visibility, row locks`);
  }
  // Both layouts must preserve every field even for a late observation packed after historical backfill.
  for (const s of schemas) await verify(s);
  for (const [index, replacement] of [[0, '[redacted by subject data deletion]'], [1, '']]) {
    for (const s of schemas) {
      const locator = (await query(`SELECT payload_block_id,payload_position FROM ${s}.raw WHERE id=$1`, [ids[index]])).rows[0];
      const before = await digest(`SELECT to_jsonb(r) FROM ${s}.raw r WHERE id=$1`, [ids[2]]);
      await query(`SELECT ${s}.replace_wire($1,$2,decode('00','hex'),NULL,'2026-10-05 00:00:00.987654+00')`, [ids[index], replacement]);
      assert.equal((await query(`SELECT lines[$2::int] IS NULL AS cleared FROM ${s}.blocks WHERE id=$1`, [locator.payload_block_id, locator.payload_position])).rows[0].cleared, true);
      if (s === schemas[1]) assert.equal((await query(`SELECT (metadata[$2::int]).created_at IS NULL AS cleared FROM ${s}.blocks WHERE id=$1`, [locator.payload_block_id, locator.payload_position])).rows[0].cleared, true);
      assert.equal(await digest(`SELECT to_jsonb(r) FROM ${s}.raw r WHERE id=$1`, [ids[2]]), before);
    }
    await query(`UPDATE ${source}.feed SET raw_line=$2,tags=decode('00','hex'),parse_error=NULL,updated_at='2026-10-05 00:00:00.987654+00' WHERE id=$1`, [ids[index], replacement]);
  }
  for (const s of schemas) {
    const locator = (await query(`SELECT payload_block_id,payload_position FROM ${s}.raw WHERE id=$1`, [ids[3]])).rows[0];
    await query(`SELECT ${s}.remove_raw($1)`, [ids[3]]);
    assert.equal((await query(`SELECT lines[$2::int] IS NULL AS cleared FROM ${s}.blocks WHERE id=$1`, [locator.payload_block_id, locator.payload_position])).rows[0].cleared, true);
    const referenced = (await query(`SELECT raw_irc_message_id FROM ${source}.messages LIMIT 1`)).rows[0].raw_irc_message_id;
    await assert.rejects(query(`SELECT ${s}.remove_raw($1)`, [referenced]), (error) => error.code === '23503');
    await assert.rejects(query(`SELECT ${s}.pack($1,0)`, [cutoff]), /Invalid batch size/);
    await assert.rejects(query(`SELECT ${s}.wire('',9223372036854775807,1::smallint)`), /Missing archived payload/);
  }
  await query(`DELETE FROM ${source}.feed WHERE id=$1`, [ids[3]]);
  for (const s of schemas) await verify(s);
  // A moderation mark belongs to the normalized message; it must not erase source evidence.
  const moderationId = (await query(`SELECT id FROM ${source}.messages LIMIT 1`)).rows[0].id;
  for (const s of schemas) {
    const before = await digest(`SELECT to_jsonb(r),${s}.wire(raw_line,payload_block_id,payload_position) FROM ${s}.raw r WHERE id=$1`, [moderationId]);
    await query(`UPDATE ${source}.messages SET deleted_at='2026-10-05 00:00:00+00',cleared_at='2026-10-05 00:00:01+00' WHERE id=$1`, [moderationId]);
    assert.equal(await digest(`SELECT to_jsonb(r),${s}.wire(raw_line,payload_block_id,payload_position) FROM ${s}.raw r WHERE id=$1`, [moderationId]), before);
  }
  checks.push('exact microseconds/metadata/wire reconstruction', 'late observation', 'redaction and explicit empty replacement clear old slots', 'neighbours unchanged', 'physical deletion', 'referenced deletion rejected', 'invalid batch and missing locator rejected');
  checks.push('normalized moderation leaves raw evidence unchanged');
  report.correctness = checks;
}
async function concurrencyTests(report) {
  report.concurrent_writes = [];
  for (const [index, schema] of schemas.entries()) {
    const other = schemas[1 - index];
    const target = { ...synthetic(2)[1], id: uuid(`${run}:race:${index}`), context_id: null, received_at: '2026-09-01T00:00:00.123456Z' };
    await query(`INSERT INTO ${source}.feed(${inputColumns}) ${jsonInput}`, [JSON.stringify([target])]);
    for (const s of schemas) await insert(s, `WHERE id='${target.id}'::uuid`);
    const packer = await pool.connect();
    const eraser = await pool.connect();
    let erased;
    try {
      await packer.query('BEGIN');
      await packer.query(`SELECT ${schema}.pack($1,256)`, [cutoff]);
      const locator = (await packer.query(`SELECT payload_block_id,payload_position FROM ${schema}.raw WHERE id=$1`, [target.id])).rows[0];
      assert.notEqual(locator.payload_block_id, null);
      const arriving = { ...target, id: uuid(`${run}:concurrent:${index}`), received_at: '2026-10-05T00:00:00.654321Z' };
      await query(`INSERT INTO ${source}.feed(${inputColumns}) ${jsonInput}`, [JSON.stringify([arriving])]);
      const insertMs = await duration(() => insert(schema, `WHERE id='${arriving.id}'::uuid`));
      // Privacy erasure is submitted while packer holds the selected key lock.
      erased = eraser.query(`SELECT ${schema}.replace_wire($1,'[redacted by subject data deletion]',decode('00','hex'),NULL,'2026-10-05 00:00:00.987654+00')`, [target.id]);
      let waiting = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        waiting = (await query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [eraser.processID])).rows[0]?.wait_event_type === 'Lock';
        if (waiting) break;
        await new Promise((done) => setTimeout(done, 10));
      }
      assert.equal(waiting, true, 'Erasure must serialize with in-flight packing');
      await packer.query('COMMIT'); await erased;
      assert.equal((await query(`SELECT lines[$2::int] IS NULL AS cleared FROM ${schema}.blocks WHERE id=$1`, [locator.payload_block_id, locator.payload_position])).rows[0].cleared, true);
      await insert(other, `WHERE id='${arriving.id}'::uuid`);
      await query(`SELECT ${other}.replace_wire($1,'[redacted by subject data deletion]',decode('00','hex'),NULL,'2026-10-05 00:00:00.987654+00')`, [target.id]);
      await query(`UPDATE ${source}.feed SET raw_line='[redacted by subject data deletion]',tags=decode('00','hex'),parse_error=NULL,updated_at='2026-10-05 00:00:00.987654+00' WHERE id=$1`, [target.id]);
      for (const s of schemas) await assert.rejects(insert(s, `WHERE id='${target.id}'::uuid`), (error) => error.code === '23505');
      report.concurrent_writes.push({ layout: index === 0 ? 'baseline' : 'candidate', insert_while_packing_ms: insertMs, erasure_waited_for_packer: waiting });
    } finally { await packer.query('ROLLBACK'); if (erased) await erased; packer.release(); eraser.release(); }
  }
  for (const s of schemas) await verify(s);
  report.correctness.push('ingestion continues while packing transaction is open', 'erasure racing with packing clears the committed block', 'duplicate original IDs rejected');
}
async function mutationCosts(report) {
  report.redaction = [];
  for (const s of schemas) {
    const sets = [
      (await query(`SELECT id FROM ${s}.raw WHERE payload_block_id=(SELECT min(payload_block_id) FROM ${s}.raw) ORDER BY payload_position LIMIT 20`)).rows.map((r) => r.id),
      (await query(`SELECT DISTINCT ON(payload_block_id) id FROM ${s}.raw WHERE payload_block_id IS NOT NULL ORDER BY payload_block_id,id LIMIT 20`)).rows.map((r) => r.id)
    ];
    for (const [i, ids] of sets.entries()) {
      const samples = [];
      const client = await pool.connect();
      try {
        for (let repeat = 0; repeat < 5; repeat++) {
          await client.query('BEGIN');
          const result = (await client.query(`EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON)
            SELECT ${s}.replace_wire(id,'[redacted by subject data deletion]',decode('00','hex'),NULL,'2026-10-05 00:00:00.987654+00') FROM unnest($1::uuid[]) ids(id)`, [ids])).rows[0]['QUERY PLAN'][0];
          samples.push({ ms: result['Execution Time'], wal_bytes: result.Plan['WAL Bytes'] ?? 0 });
          await client.query('ROLLBACK');
        }
      } finally { await client.query('ROLLBACK'); client.release(); }
      report.redaction.push({ layout: s === schemas[0] ? 'baseline' : 'candidate', shape: i === 0 ? 'same_block' : 'spread_blocks', rows: ids.length,
        ...summary(samples.map((r) => r.ms)), wal_bytes_max: Math.max(...samples.map((r) => r.wal_bytes)) });
    }
  }
}
async function main() {
  const version = (await query('SELECT version() AS version')).rows[0].version;
  assert.match(version, /PostgreSQL 16\./);
  let rows;
  let extractedBytes = 0;
  if (values.sample) {
    const input = await readFile(resolve(values.sample)); extractedBytes = input.length;
    assert.ok(extractedBytes <= 100 * 1024 * 1024);
    rows = input.toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(rows.length > 0 && rows.length <= 100000);
  } else {
    const n = Number(values.rows); assert.ok(Number.isInteger(n) && n >= 1000 && n <= 100000);
    rows = synthetic(n);
  }
  const report = { name: run, version, node_version: process.version, synthetic: !values.sample, rows: rows.length, extracted_bytes: extractedBytes, cutoff, cpu_limit: 2, timings: {}, footprints: {}, reads: [] };
  // A name collision fails: the runner never resets or deletes an existing database/schema.
  for (const s of [source, ...schemas]) await query(`CREATE SCHEMA ${s}`);
  await query(`CREATE TABLE ${source}.feed(id uuid PRIMARY KEY,raw_line text NOT NULL,parsed_command text,tags bytea NOT NULL,
    received_at timestamptz NOT NULL,processing_status text NOT NULL,parse_error text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,context_id integer);
    CREATE TABLE ${source}.contexts(id integer PRIMARY KEY,channel_login text,bot_account_id uuid,irc_connection_id uuid)`);
  const contexts = new Map(rows.filter((r) => r.context_id != null).map((r) => [r.context_id, { ...r.context, id: r.context_id }]));
  await query(`INSERT INTO ${source}.contexts SELECT * FROM jsonb_populate_recordset(NULL::${source}.contexts,$1::jsonb)`, [JSON.stringify([...contexts.values()])]);
  for (let i = 0; i < rows.length; i += 500) await query(`INSERT INTO ${source}.feed(${inputColumns}) ${jsonInput}`, [JSON.stringify(rows.slice(i, i + 500))]);
  report.cohorts = Object.entries(Object.groupBy(rows, (r) => r.cohort ?? 'unspecified')).map(([name, group]) => ({ name, rows: group.length, contexts: new Set(group.map((r) => r.context_id)).size }));
  const schemaSql = await readFile(resolve(here, 'schema.sql'), 'utf8');
  const candidateSql = await readFile(resolve(here, 'candidate.sql'), 'utf8');
  for (const [i, s] of schemas.entries()) {
    await query(schemaSql.replaceAll('__SCHEMA__', s));
    if (i === 1) await query(candidateSql.replaceAll('__SCHEMA__', s));
    await query(`INSERT INTO ${s}.contexts SELECT * FROM ${source}.contexts`);
    report.timings[`${i === 0 ? 'baseline' : 'candidate'}_insert_ms`] = await duration(() => insert(s));
  }
  const batches = schemas.map(() => []);
  let remaining = [true, true];
  const walStart = (await query('SELECT pg_current_wal_insert_lsn() AS lsn')).rows[0].lsn;
  const walBytes = [0, 0];
  while (remaining.some(Boolean)) {
    for (let i = 0; i < schemas.length; i++) if (remaining[i]) {
      const before = (await query('SELECT pg_current_wal_insert_lsn() AS lsn')).rows[0].lsn;
      let packed;
      const ms = await duration(async () => { packed = (await query(`SELECT ${schemas[i]}.pack($1,256) AS n`, [cutoff])).rows[0].n; });
      walBytes[i] += Number((await query('SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1) AS bytes', [before])).rows[0].bytes);
      remaining[i] = packed > 0;
      if (packed > 0) batches[i].push(ms);
    }
  }
  report.packing = batches.map((times, i) => ({ layout: i === 0 ? 'baseline' : 'candidate', ...summary(times), total_ms: times.reduce((a, b) => a + b, 0), wal_bytes: walBytes[i] }));
  report.packing_total_wal_bytes = Number((await query('SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1) AS bytes', [walStart])).rows[0].bytes);
  for (const [i, s] of schemas.entries()) {
    const name = i === 0 ? 'baseline' : 'candidate';
    await verify(s);
    report.footprints[`${name}_before_rewrite`] = await footprint(s);
    const tables = (await query("SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename", [s])).rows;
    for (const { tablename } of tables) { await query(`VACUUM (FULL,ANALYZE) ${s}.${tablename}`); await query(`VACUUM (ANALYZE) ${s}.${tablename}`); }
    report.footprints[`${name}_compact`] = await footprint(s);
  }
  // Consumer fixtures model the existing indexed message history paths, independently of either raw layout.
  await query(`CREATE TABLE ${source}.messages AS SELECT id,id AS raw_irc_message_id,'user_'||(row_number() OVER(ORDER BY received_at,id)%128)::text AS chatter_user_id,
    'channel_'||coalesce(context_id,0)::text AS broadcaster_user_id,'stream_'||coalesce(context_id,0)::text||'_'||(received_at::date)::text AS twitch_stream_id,
    received_at,right(raw_line,80) AS raw_text,NULL::timestamptz AS deleted_at,NULL::timestamptz AS cleared_at,
    CASE WHEN row_number() OVER(ORDER BY received_at,id)%13=0 THEN 'relayed_other'::text ELSE NULL::text END AS shared_chat_source_channel_id
    FROM ${source}.feed WHERE parsed_command='';
    ALTER TABLE ${source}.messages ADD PRIMARY KEY(id),
    ADD FOREIGN KEY(raw_irc_message_id) REFERENCES ${schemas[0]}.raw(id),ADD FOREIGN KEY(raw_irc_message_id) REFERENCES ${schemas[1]}.keys(id);
    CREATE INDEX ON ${source}.messages(chatter_user_id,received_at);
    CREATE INDEX ON ${source}.messages(broadcaster_user_id,received_at);
    CREATE INDEX ON ${source}.messages(twitch_stream_id,received_at);
    CREATE TABLE ${source}.streams AS SELECT DISTINCT twitch_stream_id AS id,broadcaster_user_id AS channel,true AS is_finnish_eligible FROM ${source}.messages;
    ALTER TABLE ${source}.streams ADD PRIMARY KEY(id);
    CREATE TABLE ${source}.privacy(user_id text PRIMARY KEY,hidden boolean NOT NULL);
    INSERT INTO ${source}.privacy VALUES('user_3',true),('channel_999',true);
    CREATE TABLE ${source}.bots(user_id text PRIMARY KEY); INSERT INTO ${source}.bots VALUES('user_4')`);
  for (const name of ['messages', 'streams', 'privacy', 'bots']) await query(`VACUUM (ANALYZE) ${source}.${name}`);
  report.consumer_fixture_bytes = Number((await query(`SELECT sum(pg_total_relation_size(oid)) AS bytes FROM pg_class WHERE relnamespace=$1::regnamespace AND relname IN ('messages','streams','privacy','bots')`, [source])).rows[0].bytes);
  const cohorts = (await query(`SELECT twitch_stream_id AS stream,min(broadcaster_user_id) AS channel,min(chatter_user_id) AS chatter,count(*) AS n
    FROM ${source}.messages GROUP BY twitch_stream_id HAVING count(*)>10 ORDER BY count(*) DESC,twitch_stream_id`)).rows;
  assert.ok(cohorts.length >= 2);
  const ids = (await query(`SELECT id FROM ${source}.feed WHERE raw_line<>'' ORDER BY md5(id::text) LIMIT 200`)).rows.map((r) => r.id);
  for (const c of readCases(cohorts[0], cohorts.at(-1), ids)) {
    assert.equal(await digest(c.sql(schemas[0]), c.params), await digest(c.sql(schemas[1]), c.params), `Reader output differs: ${c.name}`);
    const times = [[], []]; const io = [[], []];
    for (let round = 0; round < 25; round++) {
      for (const i of round % 2 === 0 ? [0, 1] : [1, 0]) {
        const result = await explain(c.sql(schemas[i]), c.params);
        if (round >= 5) { times[i].push(result.ms); io[i].push(result); }
      }
    }
    report.reads.push({ name: c.name, baseline: summary(times[0]), candidate: summary(times[1]),
      median_ratio: summary(times[1]).median_ms / summary(times[0]).median_ms,
      max_temp_blocks: Math.max(...io.flat().map((r) => r.temp ?? 0)) });
  }
  await mutationCosts(report);
  await mutationTests(report);
  await concurrencyTests(report);
  await mkdir(resolve(root, '.cache/raw-metadata-bench'), { recursive: true });
  await writeFile(resolve(root, `.cache/raw-metadata-bench/${run}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ name: run, rows: report.rows, synthetic: report.synthetic,
    footprints: Object.fromEntries(Object.entries(report.footprints).map(([name, size]) => [name, size.total_bytes])),
    timings: report.timings, packing: report.packing, reads: report.reads, redaction: report.redaction, concurrent_writes: report.concurrent_writes, correctness: report.correctness,
    report: resolve(root, `.cache/raw-metadata-bench/${run}.json`) }, null, 2));
}
try { await main(); } catch (error) { console.error(`Benchmark failed: ${error.message}`); process.exitCode = 1; } finally { await pool.end(); }
