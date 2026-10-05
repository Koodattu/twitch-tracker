import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read-only, bounded source sampling. Never prints sampled rows or credentials.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const directory = resolve(root, '.cache/raw-metadata-bench');
await mkdir(directory, { recursive: true });
const ledgerPath = resolve(directory, 'extraction-ledger.json');
let ledger;
try { ledger = JSON.parse(await readFile(ledgerPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; ledger = []; }
const rowCap = 8192;
const byteCap = 20 * 1024 * 1024;
// Failed or interrupted attempts retain their entire reservation. No automatic retries.
const reservedRows = ledger.reduce((n, r) => n + (r.actual_rows ?? r.row_cap), 0);
const reservedBytes = ledger.reduce((n, r) => n + (r.actual_bytes ?? r.byte_cap), 0);
assert.ok(reservedRows + rowCap <= 100000 && reservedBytes + byteCap <= 100 * 1024 * 1024, 'Project extraction budget exhausted');
const filename = `sample_${ledger.length + 1}.ndjson`;
const entry = { filename, row_cap: rowCap, byte_cap: byteCap, started_at: new Date().toISOString(), status: 'reserved' };
ledger.push(entry);
await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
const sql = `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='1s'; SET LOCAL work_mem='8MB';
WITH windows(label,starts) AS (VALUES
  ('aug20_quiet','2026-08-20 04:00:00+00'::timestamptz),('aug20_active','2026-08-20 17:00:00+00'::timestamptz),
  ('sep05_quiet','2026-09-05 04:00:00+00'::timestamptz),('sep05_active','2026-09-05 17:00:00+00'::timestamptz),
  ('sep21_quiet','2026-09-21 04:00:00+00'::timestamptz),('sep21_active','2026-09-21 17:00:00+00'::timestamptz),
  ('oct02_quiet','2026-10-02 04:00:00+00'::timestamptz),('oct02_active','2026-10-02 17:00:00+00'::timestamptz)
), selected AS MATERIALIZED (
  SELECT w.label,r.* FROM windows w CROSS JOIN LATERAL (
    SELECT * FROM raw_irc_messages WHERE received_at>=w.starts AND received_at<w.starts+interval '1 hour'
    ORDER BY received_at,id LIMIT 1024
  ) r
), expanded AS MATERIALIZED (
  SELECT b.id,line,slot FROM raw_irc_payload_blocks b
  JOIN (SELECT DISTINCT payload_block_id FROM selected WHERE payload_block_id IS NOT NULL) wanted ON wanted.payload_block_id=b.id
  CROSS JOIN LATERAL unnest(b.lines) WITH ORDINALITY payload(line,slot)
), serialized AS MATERIALIZED (
  SELECT r.received_at,r.id,jsonb_build_object('id',r.id,'raw_line',CASE WHEN r.payload_block_id IS NULL THEN r.raw_line ELSE p.line END,
    'parsed_command',r.parsed_command,'tags_hex',encode(r.tags,'hex'),'received_at',r.received_at,'processing_status',r.processing_status,
    'parse_error',r.parse_error,'created_at',r.created_at,'updated_at',r.updated_at,'context_id',r.context_id,'cohort',r.label,
    'context',jsonb_build_object('id',c.id,'channel_login',c.channel_login,'bot_account_id',c.bot_account_id,'irc_connection_id',c.irc_connection_id))::text AS line
  FROM selected r LEFT JOIN expanded p ON p.id=r.payload_block_id AND p.slot=r.payload_position
  LEFT JOIN raw_irc_contexts c ON c.id=r.context_id
), bounded AS (
  SELECT line,row_number() OVER(ORDER BY received_at,id) AS n,
    sum(octet_length(convert_to(line,'UTF8'))+1) OVER(ORDER BY received_at,id ROWS UNBOUNDED PRECEDING) AS bytes
  FROM serialized
) SELECT line FROM bounded WHERE n<=${rowCap} AND bytes<=${byteCap} ORDER BY n;
COMMIT;`;
const script = `set -eu
container=$(docker ps --filter label=com.docker.compose.project=twitch-tracker --filter label=com.docker.compose.service=postgres --format '{{.Names}}')
test "$container" = twitch-tracker-postgres-1
docker exec -i -e PGCLIENTENCODING=UTF8 -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=1000' "$container" sh -c 'exec psql -X -q -A -t -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
${sql}
SQL`;
const encoded = Buffer.from(script).toString('base64');
const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'vaarattu-server', `echo ${encoded} | base64 -d | sh`], { windowsHide: true });
const chunks = []; const errors = []; let received = 0; let exceeded = false;
child.stdout.on('data', (chunk) => {
  received += chunk.length;
  if (received > byteCap) { exceeded = true; child.kill(); return; }
  chunks.push(chunk);
});
child.stderr.on('data', (chunk) => { if (errors.reduce((n, b) => n + b.length, 0) < 65536) errors.push(chunk); });
const timeout = setTimeout(() => child.kill(), 25000);
const code = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done); }).finally(() => clearTimeout(timeout));
if (code !== 0 || exceeded) {
  await writeFile(resolve(directory, `${filename}.error`), Buffer.concat(errors));
  throw new Error('Sampling failed; reservation retained. Private diagnostic saved beside the ledger. Do not retry automatically.');
}
const buffer = Buffer.concat(chunks);
const lines = buffer.toString('utf8').trim().split('\n').filter(Boolean);
assert.ok(lines.length > 0 && lines.length <= rowCap);
const rows = lines.map((line) => JSON.parse(line));
assert.ok(rows.every((r) => typeof r.raw_line === 'string'), 'Missing wire data in sample');
assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
await writeFile(resolve(directory, filename), buffer, { flag: 'wx' });
Object.assign(entry, { status: 'complete', actual_rows: rows.length, actual_bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'),
  cohorts: Object.entries(Object.groupBy(rows, (r) => r.cohort)).map(([label, group]) => ({ label, rows: group.length, contexts: new Set(group.map((r) => r.context_id)).size })) });
await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
console.log(JSON.stringify({ filename, rows: entry.actual_rows, bytes: entry.actual_bytes, cohorts: entry.cohorts, total_project_reserved_rows: reservedRows + rows.length, total_project_reserved_bytes: reservedBytes + buffer.length }, null, 2));
