import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import pg from 'pg';
import {definitions} from '../history-blocks/layout.mjs';

// Isolated physical-size experiment, not an application schema or migration.
const url = new URL(process.env.HISTORY_BENCH_DATABASE_URL ?? 'postgres://benchmark@127.0.0.1:55438/history_blocks_benchmark');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname) && url.pathname === '/history_blocks_benchmark');
const client = new pg.Client({connectionString:url.toString(),options:'-c statement_timeout=30000 -c lock_timeout=1000 -c timezone=UTC'});
const input = await readFile(new URL('../../../../.cache/raw-metadata-bench/history_2.ndjson',import.meta.url));
assert.equal(createHash('sha256').update(input).digest('hex'), '4b4137bda69df5c158b3add0384558fea22557192498882c570378f1b2c4391f');
const data = input.toString('utf8').trim().split('\n').map(JSON.parse);
const keyTable = name => ['broadcaster_user_id','chatter_user_id','shared_chat_source_channel_id'].includes(name) ? 'users'
  : name === 'twitch_stream_id' ? 'streams' : null;
const report = {created_at:new Date().toISOString(),node:process.version,input_rows:data.length,
  input_sha256:createHash('sha256').update(input).digest('hex'),groups:{},checks:[]};
const size = async table => (await client.query(`SELECT pg_relation_size($1::regclass)::float8 AS heap_bytes,
  pg_table_size($1::regclass)::float8 AS table_bytes,pg_indexes_size($1::regclass)::float8 AS index_bytes,
  pg_total_relation_size($1::regclass)::float8 AS total_bytes`,[table])).rows[0];
await client.connect();
try {
  report.postgres = (await client.query('SELECT version()')).rows[0].version;
  await client.query(`CREATE SCHEMA narrow_audit;
    CREATE TABLE narrow_audit.users(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,external text NOT NULL UNIQUE);
    CREATE TABLE narrow_audit.streams(id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,external text NOT NULL UNIQUE);`);
  for (const kind of ['chat','viewer']) {
    const d = definitions[kind], base = 'narrow_audit.'+kind+'_base', candidate = 'narrow_audit.'+kind+'_keys';
    await client.query(`CREATE TABLE ${base}(${d.fields.map(([name,type])=>name+' '+type).join(',')});
      CREATE TABLE ${candidate}(${d.fields.map(([name,type])=>name+' '+(keyTable(name)?type.replace('text','integer'):type)).join(',')});`);
    const records = data.filter(r=>r.kind===kind).map(r=>r.record);
    for (let i=0;i<records.length;i+=1000)
      await client.query(`INSERT INTO ${base} SELECT * FROM jsonb_populate_recordset(NULL::${base},$1)`,[JSON.stringify(records.slice(i,i+1000))]);
    for (const dict of ['users','streams']) {
      const fields = d.fields.filter(([name])=>keyTable(name)===dict).map(([name])=>name);
      await client.query(`INSERT INTO narrow_audit.${dict}(external)
        SELECT DISTINCT v FROM ${base} CROSS JOIN LATERAL unnest(ARRAY[${fields.join(',')}]) v
        WHERE v IS NOT NULL ORDER BY v ON CONFLICT(external) DO NOTHING`);
    }
    const encoded = d.fields.map(([name])=>keyTable(name)
      ? `(SELECT id FROM narrow_audit.${keyTable(name)} WHERE external=b.${name}) AS ${name}` : 'b.'+name);
    await client.query(`INSERT INTO ${candidate} SELECT ${encoded.join(',')} FROM ${base} b`);
    const decoded = d.fields.map(([name])=>keyTable(name)
      ? `(SELECT external FROM narrow_audit.${keyTable(name)} WHERE id=b.${name}) AS ${name}` : 'b.'+name);
    await client.query(`CREATE VIEW narrow_audit.${kind}_decoded AS SELECT ${decoded.join(',')} FROM ${candidate} b`);
    const mismatches = (await client.query(`SELECT count(*)::int AS n FROM (
      (SELECT * FROM ${base} EXCEPT ALL SELECT * FROM narrow_audit.${kind}_decoded)
      UNION ALL (SELECT * FROM narrow_audit.${kind}_decoded EXCEPT ALL SELECT * FROM ${base})) differences`)).rows[0].n;
    assert.equal(mismatches,0);
    report.checks.push({check:kind+'_all_fields_exact',rows:records.length,passed:true});
    for (const table of [base,candidate]) {
      await client.query(`ALTER TABLE ${table} ADD PRIMARY KEY(${d.key});
        CREATE INDEX ON ${table}(broadcaster_user_id,${d.time});
        CREATE INDEX ON ${table}(twitch_stream_id,${d.time});
        ${kind==='chat' ? `CREATE INDEX ON ${table}(chatter_user_id,received_at);
          CREATE INDEX ON ${table}(received_at);
          CREATE INDEX ON ${table} USING brin((coalesce(sent_at,received_at))) WITH(pages_per_range=32,autosummarize=on);` : ''}`);
      await client.query(`VACUUM (ANALYZE) ${table}`);
    }
    const heap = (await client.query(`SELECT
      (SELECT avg(ceil(pg_column_size(b)/8.0)*8+4)::float8 FROM ${base} b) AS baseline_aligned_bytes,
      (SELECT avg(ceil(pg_column_size(b)/8.0)*8+4)::float8 FROM ${candidate} b) AS candidate_aligned_bytes`)).rows[0];
    const indexes = (await client.query(`SELECT t.relname AS table_name,c.relname AS name,
      pg_relation_size(c.oid)::float8 AS bytes,pg_get_indexdef(c.oid) AS definition
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
      WHERE i.indrelid IN($1::regclass,$2::regclass) ORDER BY t.relname,c.relname`,[base,candidate])).rows;
    report.groups[kind] = {rows:records.length,baseline:await size(base),candidate:await size(candidate),heap,indexes};
  }
  report.dictionaries = {};
  for (const dict of ['users','streams']) report.dictionaries[dict] = {
    rows:(await client.query(`SELECT count(*)::int AS n FROM narrow_audit.${dict}`)).rows[0].n,
    ...await size('narrow_audit.'+dict),
    sequence_bytes:(await client.query('SELECT pg_total_relation_size($1::regclass)::float8 AS n',['narrow_audit.'+dict+'_id_seq'])).rows[0].n
  };
  // Index-only control at identical key cardinality and load order. The second
  // timestamp is retained as a native ordering key; no posting pages or GIN.
  await client.query(`CREATE TABLE narrow_audit.index_control AS
    SELECT n AS internal, (100000000+n)::text AS external,
      timestamptz '2026-01-01'+n*interval '1 microsecond' AS at FROM generate_series(1,100000) n;
    CREATE INDEX control_text ON narrow_audit.index_control(external,at);
    CREATE INDEX control_integer ON narrow_audit.index_control(internal,at);`);
  report.index_control = (await client.query(`SELECT 100000 AS rows,
    pg_relation_size('narrow_audit.control_text')::float8 AS text_bytes,
    pg_relation_size('narrow_audit.control_integer')::float8 AS integer_bytes`)).rows[0];
  const restoredKeys = (await client.query(`SELECT count(*)::int AS n FROM narrow_audit.users WHERE external IN ('000123','123','non-numeric')`)).rows[0].n;
  assert.equal(restoredKeys,0);
  await client.query(`INSERT INTO narrow_audit.users(external) VALUES ('000123'),('123'),('non-numeric')`);
  assert.equal((await client.query(`SELECT count(DISTINCT id)::int AS n FROM narrow_audit.users WHERE external IN ('000123','123','non-numeric')`)).rows[0].n,3);
  report.checks.push({check:'distinct_external_spellings_preserved',passed:true});
  // Stored relation measurement above includes page headers, alignment, indexes,
  // TOAST and map sequences. Both sides are fresh builds; no bloat credit.
  await writeFile(new URL('keys-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({checks:report.checks,groups:Object.fromEntries(Object.entries(report.groups).map(([k,g])=>[k,
    {rows:g.rows,baseline:g.baseline,candidate:g.candidate,heap:g.heap}])),dictionaries:report.dictionaries,index_control:report.index_control},null,2));
} finally {
  await client.end();
}
