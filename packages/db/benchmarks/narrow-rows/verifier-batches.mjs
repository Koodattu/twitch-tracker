import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import pg from 'pg';
const require=createRequire(import.meta.url),ts=require('typescript');
const database='storage_verifier_batches_test';
const admin=new pg.Client({connectionString:'postgres://benchmark@127.0.0.1:55438/postgres'});
await admin.connect();
assert.equal((await admin.query('select count(*)::int n from pg_database where datname=$1',[database])).rows[0].n,0,'Use a fresh task-owned synthetic database.');
await admin.query('create database '+database);await admin.end();
const url='postgres://benchmark@127.0.0.1:55438/'+database;
const client=new pg.Client({connectionString:url});await client.connect();
const migrations=new URL('../../migrations/',import.meta.url);
for(const name of (await readdir(migrations)).filter(n=>n.endsWith('.sql')).sort())await client.query(await readFile(new URL(name,migrations),'utf8'));
await client.query(`insert into raw_irc_payload_blocks(lines)
 select array_agg('@id=synthetic-'||n||' :fixture PRIVMSG #fixture :payload '||repeat('x',300) order by n)
 from generate_series(1,50003) n group by (n-1)/256 order by (n-1)/256;
 insert into raw_irc_messages(raw_line,payload_block_id,payload_position,unrelayed_source,received_at)
 select '',b.id,slot,true,timestamptz '2026-01-01 00:00:00.000001+00' + (b.id%2)*interval '1 microsecond'
 from raw_irc_payload_blocks b cross join lateral unnest(b.lines) with ordinality as p(line,slot);
 insert into raw_irc_messages(raw_line,received_at) values('synthetic-inline','2026-01-01 00:00:00.000001+00'),('','2026-01-01 00:00:00.000003+00');`);
const originalTs=execFileSync('git',['-c','safe.directory='+process.cwd().replaceAll('\\','/'),'show','8f8296c46bcc938801552d36be072eeaf890f562:packages/db/src/verify-storage.ts'],{encoding:'utf8'});
const originalPath=new URL('../../dist/verify-storage-original.js',import.meta.url);
await writeFile(originalPath,ts.transpileModule(originalTs,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText);
function run(script){return spawnSync(process.execPath,['packages/db/dist/'+script+'.js','--database',database],{env:{...process.env,DATABASE_URL:url},encoding:'utf8',windowsHide:true});}
try{
 const original=run('verify-storage-original'),bounded=run('verify-storage');
 assert.equal(original.status,0,original.stderr);assert.equal(bounded.status,0,bounded.stderr);
 assert.deepEqual(JSON.parse(bounded.stdout).fingerprints,JSON.parse(original.stdout).fingerprints);
 assert.equal(JSON.parse(bounded.stdout).fingerprints.raw_irc_messages.rows,'50005');
 await client.query('update raw_irc_records set unrelayed_source=false where id=(select id from raw_irc_records where payload_block_id is not null limit 1)');
 const corrupt=run('verify-storage');assert.notEqual(corrupt.status,0);assert.match(corrupt.stderr,/Raw payloads or source-attribution cache differ/);
 const result={at:new Date().toISOString(),syntheticRows:50005,checks:['Three keyset batches match original canonical fingerprints across timestamp ties and microseconds','Inline and archived records both included','Corrupted archived source cache is rejected']};
 await writeFile(new URL('verifier-batches-results.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}finally{await client.end();}
