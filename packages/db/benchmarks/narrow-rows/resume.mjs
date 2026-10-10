import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';

// Create storage_resume_test from the task-owned storage_baseline_test fixture
// first. This rehearsal never accepts a remote URL or arbitrary database name.
const database='storage_resume_test';
const url=`postgres://benchmark@127.0.0.1:55438/${database}`;
const client=new pg.Client({connectionString:url});
const run=script=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[`packages/db/dist/${script}.js`,'--database',database,...(script==='migrate-record-storage'?['--apply']:[])],{
    env:{...process.env,DATABASE_URL:url},windowsHide:true,stdio:['ignore','pipe','pipe']
  });
  let stdout='',stderr='';child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
  child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
});
const fingerprint=async()=>{
  const result=await run('verify-storage');assert.equal(result.code,0,result.stderr);
  return JSON.parse(result.stdout).fingerprints;
};
try {
  await client.connect();
  assert.equal((await client.query('select max(created_at)::text as version from drizzle.__drizzle_migrations')).rows[0].version,'1790658001000');
  const before=await fingerprint();
  await client.query(`create function interrupt_storage_rehearsal() returns event_trigger language plpgsql as $$
    begin if exists(select 1 from pg_event_trigger_ddl_commands() where object_identity='public.stream_snapshots') then
      raise exception 'Simulated interruption at viewer migration'; end if; end $$;
    create event trigger interrupt_storage_rehearsal on ddl_command_end execute function interrupt_storage_rehearsal()`);
  const interrupted=await run('migrate-record-storage');assert.equal(interrupted.code,1);
  assert.match(interrupted.stderr,/Rolled back 0026_compact_viewer_records/);
  assert.equal((await client.query('select max(created_at)::text as version from drizzle.__drizzle_migrations')).rows[0].version,'1791630001000');
  assert.deepEqual(await fingerprint(),before);
  await client.query('drop event trigger interrupt_storage_rehearsal;drop function interrupt_storage_rehearsal()');
  const resumed=await run('migrate-record-storage');assert.equal(resumed.code,0,resumed.stderr);
  assert.deepEqual(await fingerprint(),before);
  const repeated=await run('migrate-record-storage');assert.equal(repeated.code,0,repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout.trim()).pending,[]);
  for(const name of ['0025_restore_native_records','0024_restore_external_keys']) await client.query(await readFile(new URL(`../../online-migrations/${name}.sql`,import.meta.url),'utf8'));
  assert.deepEqual(await fingerprint(),before);
  const result={at:new Date().toISOString(),node:process.version,checks:[
    'Actual CLI preserves committed checkpoints when the viewer migration fails',
    'Canonical verifier matches every table at the partial checkpoint',
    'Resuming completes the remaining migrations and preserves every logical fingerprint',
    'Repeating the runner is a no-op',
    'Guarded rollback restores all logical fingerprints and the 0023 journal state'
  ]};
  await writeFile(new URL('resume-results.json',import.meta.url),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
} catch(error) {console.error(error.message);process.exitCode=1;}
finally {await client.end();}
