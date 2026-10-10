import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { encodeExternalKey, decodeExternalKey } from '../../src/compact-external-key.ts';

// Never accepts a production URL. Both databases must be newly created and empty.
const clients = ['storage_baseline_test','storage_candidate_test'].map(database => new pg.Client({
  host:'127.0.0.1',port:55438,user:'benchmark',database,
  options:'-c timezone=UTC -c statement_timeout=120000 -c lock_timeout=2000'
}));
const journal = JSON.parse(await readFile(new URL('../../migrations/meta/_journal.json',import.meta.url),'utf8')).entries;
const historyBytes = await readFile(new URL('../../../../.cache/raw-metadata-bench/history_2.ndjson',import.meta.url));
const rawBytes = await readFile(new URL('../../../../.cache/raw-metadata-bench/sample_1.ndjson',import.meta.url));
assert.equal(createHash('sha256').update(historyBytes).digest('hex'),'4b4137bda69df5c158b3add0384558fea22557192498882c570378f1b2c4391f');
assert.equal(createHash('sha256').update(rawBytes).digest('hex'),'2db123d2a3711ec5d1925cb38e6791d295dba8636bfa2fa71b691fb9b84fca50');
const history = historyBytes.toString().trim().split('\n').map(JSON.parse);
const raw = rawBytes.toString().trim().split('\n').map(JSON.parse);
const users = new Set(), streams = new Map(), rawIds = new Set(raw.map(r=>r.id)), events = new Set();
for (const {record:r} of history) {
  for (const key of ['broadcaster_user_id','chatter_user_id']) if (r[key]!=null) users.add(r[key]);
  if (r.twitch_stream_id!=null) streams.set(r.twitch_stream_id,r.broadcaster_user_id);
  if (r.raw_irc_message_id!=null) rawIds.add(r.raw_irc_message_id);
  if (r.raw_eventsub_event_id!=null) events.add(r.raw_eventsub_event_id);
}
const report = {at:new Date().toISOString(),node:process.version,privateInputRows:history.length+raw.length,
  checks:[],sizes:{},timing:{},plans:{}};
const timed = async run => { const t=performance.now();const result=await run();return {ms:performance.now()-t,result}; };
const migrate = async (client,entry) => {
  const source=await readFile(new URL(`../../migrations/${entry.tag}.sql`,import.meta.url),'utf8');
  await client.query('begin');
  try {
    await client.query(source);
    await client.query('insert into drizzle.__drizzle_migrations(hash,created_at) values($1,$2)',[createHash('sha256').update(source).digest('hex'),entry.when]);
    await client.query('commit');
  } catch(error) { await client.query('rollback');throw error; }
};
const batch = async (records,run) => {for(let i=0;i<records.length;i+=1000) await run(records.slice(i,i+1000));};
const size = async (client,name) => (await client.query(`select pg_relation_size($1::regclass)::float8 as heap,
  pg_indexes_size($1::regclass)::float8 as indexes,pg_total_relation_size($1::regclass)::float8 as total,
  (select reltuples from pg_class where oid=$1::regclass)::float8 as rows`,[name])).rows[0];
const sizes = async (client) => {
  const result={};
  for (const [logical,physical] of [['chat_messages','chat_message_records'],['stream_snapshots','stream_snapshot_records'],['raw_irc_messages','raw_irc_records'],['twitch_users','twitch_users'],['stream_sessions','stream_sessions'],['stream_activity_buckets','stream_activity_buckets'],['raw_irc_payload_blocks','raw_irc_payload_blocks']]) {
    const table=(await client.query('select to_regclass($1) as physical',[physical])).rows[0].physical?physical:logical;
    await client.query(`vacuum (analyze) ${table}`);
    await client.query(`reindex table ${table}`);
    result[logical]=await size(client,table);
  }
  return result;
};
const fingerprint = async (client,compact) => {
  const result={};
  for(const table of ['chat_messages','stream_snapshots','raw_irc_messages','stream_activity_buckets']) {
    let row='to_jsonb(r)';
    if(compact && table!=='raw_irc_messages') {
      const keys=table==='stream_activity_buckets'?['twitch_stream_id']:['broadcaster_user_id','twitch_stream_id',...(table==='chat_messages'?['chatter_user_id','shared_chat_source_channel_id']:[])];
      row+=`||jsonb_build_object(${keys.map(k=>`'${k}',decode_external_key(${k})`).join(',')})`;
    }
    if(compact && table==='chat_messages') row+="||jsonb_build_object('source',decode_common_label(source,'irc'),'message_type',decode_common_label(message_type,'privmsg'))";
    if(compact && table==='stream_snapshots') row+="||jsonb_build_object('tags',decode_compact_json(tags))";
    result[table]=(await client.query(`with hashes as (select md5((${row})::text) h from ${table} r)
      select count(*)::text rows,sum(('x'||substr(h,1,16))::bit(64)::bigint::numeric)::text h1,
      sum(('x'||substr(h,17,16))::bit(64)::bigint::numeric)::text h2 from hashes`)).rows[0];
  }
  return result;
};
const stats = values => {const s=[...values].sort((a,b)=>a-b);return {medianMs:s[Math.floor(s.length/2)],p95Ms:s[Math.floor(s.length*.95)],minMs:s[0],maxMs:s.at(-1),n:s.length};};
try {
  for(const client of clients) {
    await client.connect();
    assert.equal((await client.query("select to_regclass('public.twitch_users') as table")).rows[0].table,null,'Use a fresh disposable benchmark database');
    await client.query('create schema drizzle;create table drizzle.__drizzle_migrations(id serial primary key,hash text not null,created_at bigint)');
    for(const entry of journal.filter(e=>e.idx<=23)) await migrate(client,entry);
    await client.query('insert into twitch_users(twitch_user_id) select unnest($1::text[])',[[...users]]);
    await client.query("insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at) select * from unnest($1::text[],$2::text[]) s, lateral (select timestamptz '2026-01-01') t",[[...streams.keys()],[...streams.values()]]);
    await client.query("insert into raw_irc_messages(id,raw_line,received_at,created_at,updated_at) select id,'',timestamptz '2026-01-01',timestamptz '2026-01-01',timestamptz '2026-01-01' from unnest($1::uuid[]) id",[[...rawIds]]);
    await client.query("insert into raw_eventsub_events(id,event_type,event_version,message_type,payload,received_at,created_at,updated_at) select id,'fixture','1','notification','{}',timestamptz '2026-01-01',timestamptz '2026-01-01',timestamptz '2026-01-01' from unnest($1::uuid[]) id",[[...events]]);
    // The saved raw fixture has detached context metadata. Seed exact references locally.
    const contexts=[...new Map(raw.filter(r=>r.context!=null).map(r=>[r.context.id,r.context])).values()];
    const bots=[...new Set(contexts.map(c=>c.bot_account_id).filter(Boolean))];
    const connections=[...new Map(contexts.filter(c=>c.irc_connection_id!=null).map(c=>[c.irc_connection_id,c.bot_account_id])).entries()];
    await client.query("insert into bot_accounts(id,login) select id,id::text from unnest($1::uuid[]) id",[bots]);
    await client.query("insert into irc_connections(id,bot_account_id) select * from unnest($1::uuid[],$2::uuid[])",[connections.map(c=>c[0]),connections.map(c=>c[1])]);
    await client.query('insert into raw_irc_contexts(id,channel_login,bot_account_id,irc_connection_id) overriding system value select id,channel_login,bot_account_id,irc_connection_id from jsonb_populate_recordset(null::raw_irc_contexts,$1)',[JSON.stringify(contexts)]);
    await batch(raw,records=>client.query(`update raw_irc_messages r set raw_line=f.raw_line,tags=decode(f.tags_hex,'hex'),context_id=f.context_id,
      parsed_command=f.parsed_command,received_at=f.received_at::timestamptz,created_at=f.created_at::timestamptz,updated_at=f.updated_at::timestamptz,
      parse_error=f.parse_error,processing_status=f.processing_status::raw_processing_status from jsonb_to_recordset($1)
      as f(id uuid,raw_line text,tags_hex text,context_id int,parsed_command text,received_at text,created_at text,updated_at text,parse_error text,processing_status text) where r.id=f.id`,[JSON.stringify(records)]));
    for(const [kind,table] of [['chat','chat_messages'],['viewer','stream_snapshots']]) await batch(history.filter(r=>r.kind===kind).map(r=>r.record),records=>client.query(`insert into ${table} select * from jsonb_populate_recordset(null::${table},$1)`,[JSON.stringify(records)]));
    while((await client.query("select compact_raw_irc_batch('3000-01-01') n")).rows[0].n>0) { /* bounded native archive batches */ }
    await client.query('vacuum full raw_irc_messages');
  }
  const [base,candidate]=clients;
  console.log('Saved fixtures loaded; checking migration and rollback.');
  const original=await fingerprint(base,false);
  assert.deepEqual(await fingerprint(candidate,false),original);
  report.sizes.sampleBaseline=await sizes(base,false);
  for(const entry of journal.filter(e=>e.idx>23)) {
    const {ms}=await timed(()=>migrate(candidate,entry));
    report.timing[entry.tag+'SampleMigrationMs']=ms;
    report.sizes[entry.tag]=await sizes(candidate);
  }
  report.sizes.sampleCombined=await sizes(candidate,true);
  assert.deepEqual(await fingerprint(candidate,true),original);
  report.checks.push('All logical fields match after combined migration, including PostgreSQL microseconds');
  // Restore and verify the exact sample before loading the larger performance fixture.
  for(const name of ['0025_restore_native_records','0024_restore_external_keys']) await candidate.query(await readFile(new URL(`../../online-migrations/${name}.sql`,import.meta.url),'utf8'));
  assert.deepEqual(await fingerprint(candidate,false),original);
  report.checks.push('Both reverse migrations preserve every logical field');
  console.log('Migration and rollback matched; loading synthetic workload.');
  for(const client of clients) {
    await client.query(`insert into twitch_users(twitch_user_id) select (800000000+n)::text from generate_series(1,10000)n;
      insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at)
      select (80000000000+n)::text,(800000000+n)::text,timestamptz '2026-01-01' from generate_series(1,100)n;
      insert into raw_irc_messages(id,raw_line,parsed_command,tags,processing_status,received_at,created_at,updated_at)
      select md5('raw'||n)::uuid,'@room-id=800000001;user-id='||(800000000+case when n%5=0 then 1 else n%10000+1 end)||' :fixture PRIVMSG #fixture :message '||n,
        '',decode('00','hex'),'processed',timestamptz '2026-01-01'+n*interval '1 second',timestamptz '2026-01-01'+n*interval '1 second'+interval '1 millisecond',timestamptz '2026-01-01'+n*interval '1 second'+interval '1 millisecond'
      from generate_series(1,100000)n;
      insert into chat_messages(twitch_message_id,broadcaster_user_id,twitch_stream_id,chatter_user_id,chatter_login,received_at,sent_at,raw_text,raw_irc_message_id,created_at,updated_at)
      select encode_chat_message_id(md5('chat'||n)::uuid::text),(800000001+n%100)::text,(80000000001+n%100)::text,
        (800000000+case when n%5=0 then 1 else n%10000+1 end)::text,'fixture',timestamptz '2026-01-01'+n*interval '1 second',timestamptz '2026-01-01'+n*interval '1 second'-interval '100 milliseconds',
        'A representative synthetic chat message '||n,md5('raw'||n)::uuid,timestamptz '2026-01-01'+n*interval '1 second'+interval '1 millisecond',timestamptz '2026-01-01'+n*interval '1 second'+interval '1 millisecond'
      from generate_series(1,100000)n;
      insert into stream_snapshots(id,twitch_stream_id,broadcaster_user_id,observed_at,viewer_count,created_at,updated_at)
      select md5('viewer'||n)::uuid,(80000000001+n%100)::text,(800000001+n%100)::text,timestamptz '2026-01-01'+n*interval '1 minute',n%1000,
        timestamptz '2026-01-01'+n*interval '1 minute'+interval '1 millisecond',timestamptz '2026-01-01'+n*interval '1 minute'+interval '1 millisecond' from generate_series(1,50000)n;
      insert into stream_activity_buckets(twitch_stream_id,bucket_start,bucket_minutes,created_at,updated_at)
      select (80000000001+n%100)::text,timestamptz '2026-01-01'+n*interval '5 minutes',5,timestamptz '2026-01-01',timestamptz '2026-01-01' from generate_series(1,20000)n;`);
    while((await client.query("select compact_raw_irc_batch('3000-01-01') n")).rows[0].n>0) { /* exercise the shipped archiver */ }
    await client.query('vacuum full raw_irc_messages');
  }
  for(const entry of journal.filter(e=>e.idx>23)) await migrate(candidate,entry);
  report.sizes.workloadBaseline=await sizes(base,false); report.sizes.workloadCombined=await sizes(candidate,true);
  assert.deepEqual(await fingerprint(candidate,true),await fingerprint(base,false));
  console.log('Synthetic workload matched; comparing history and erasure.');
  const cases=[
    ['userRecent','chatter_user_id','800000001',0],['userDeep','chatter_user_id','800000001',10000],
    ['channelRecent','broadcaster_user_id','800000001',0],['channelDeep','broadcaster_user_id','800000001',500],
    ['streamRecent','twitch_stream_id','80000000001',0],
    ['viewerRecent','twitch_stream_id','80000000001',0],['viewerDeep','twitch_stream_id','80000000001',300]
  ];
  for(const [name,column,key,offset] of cases) {
    const query=name.startsWith('viewer')
      ? `select id,broadcaster_user_id,twitch_stream_id,observed_at,viewer_count,title,category_name from stream_snapshots where ${column}=$1 order by observed_at desc limit 51 offset ${offset}`
      : `select twitch_message_id,broadcaster_user_id,twitch_stream_id,chatter_user_id,chatter_login,source,message_type,raw_text,sent_at,received_at from chat_messages where ${column}=$1 order by received_at desc limit 51 offset ${offset}`;
    const samples=[[],[]];
    for(let round=0;round<44;round++) for(const i of (round%2?[1,0]:[0,1])) {
      const {ms,result}=await timed(async()=>{
        const result=await clients[i].query(query,[i?encodeExternalKey(key):key]);
        if(i) for(const row of result.rows) for(const col of ['broadcaster_user_id','twitch_stream_id','chatter_user_id']) if(row[col]!=null) row[col]=decodeExternalKey(row[col]);
        return result;
      });
      assert.equal(result.rows.length,51);if(round>=4) samples[i].push(ms);
    }
    report.timing[name]={baseline:stats(samples[0]),candidate:stats(samples[1])};
    report.plans[name]=[];
    for(const i of [0,1]) {
      const plan=(await clients[i].query('explain (analyze,buffers,format json) '+query,[i?encodeExternalKey(key):key])).rows[0]['QUERY PLAN'][0];
      const nodes=[];const visit=p=>{nodes.push({type:p['Node Type'],index:p['Index Name'],rows:p['Actual Rows'],loops:p['Actual Loops'],sharedHit:p['Shared Hit Blocks']});for(const child of p.Plans??[])visit(child);};visit(plan.Plan);
      report.plans[name].push({executionMs:plan['Execution Time'],nodes});
    }
  }
  const inserts=[[],[]];
  for(let round=0;round<14;round++) for(const i of (round%2?[1,0]:[0,1])) {
    const client=clients[i];await client.query('begin');
    try {
      const {ms}=await timed(()=>client.query(`insert into chat_messages(twitch_message_id,broadcaster_user_id,twitch_stream_id,chatter_user_id,received_at,raw_text)
        select encode_chat_message_id(md5('insert'||n)::uuid::text),$1,$2,$1,now()-interval '1 millisecond','synthetic write' from generate_series(1,1000)n on conflict do nothing`,
      i?[encodeExternalKey('800000001'),encodeExternalKey('80000000001')]:['800000001','80000000001']));
      if(round>=4) inserts[i].push(ms);
    } finally {await client.query('rollback');}
  }
  report.timing.insert1000={baseline:stats(inserts[0]),candidate:stats(inserts[1])};
  // Full, linked-source erasure with native archive-slot clearing. Roll back each
  // run, retain EXPLAIN WAL counters, and alternate sides to avoid order bias.
  const erasure=i=>`with linked as materialized (select raw_irc_message_id id from chat_messages where chatter_user_id=$1 or chatter_login='fixture-target'),
    raw as (update ${i?'raw_irc_records':'raw_irc_messages'} set raw_line='[redacted by subject data deletion]',tags=encode_compact_json('{}'::jsonb),parse_error=null,
      updated_at=now() where id in(select id from linked) returning id),
    messages as (update ${i?'chat_message_records':'chat_messages'} set chatter_user_id=null,chatter_login=null,raw_text=null,badges=encode_compact_json('{}'::jsonb),emotes=encode_compact_json('{}'::jsonb),
      updated_at=now() where chatter_user_id=$1 or chatter_login='fixture-target' returning 1)
    select (select count(*) from raw) raw,(select count(*) from messages) messages`;
  const eraseSamples=[[],[]],wal=[[],[]];
  for(let round=0;round<8;round++) for(const i of (round%2?[1,0]:[0,1])) {
    const client=clients[i];await client.query('begin');
    try {
      const {ms,result}=await timed(()=>client.query('explain (analyze,buffers,wal,format json) '+erasure(i),[i?encodeExternalKey('800000001'):'800000001']));
      if(round>=2) {eraseSamples[i].push(ms);wal[i].push(result.rows[0]['QUERY PLAN'][0].Plan['WAL Bytes']);}
    } finally {await client.query('rollback');}
    for(const table of [i?'chat_message_records':'chat_messages',i?'raw_irc_records':'raw_irc_messages','raw_irc_payload_blocks']) await client.query('vacuum (analyze) '+table);
  }
  report.timing.erasure={baseline:stats(eraseSamples[0]),candidate:stats(eraseSamples[1]),walBytes:wal};
  report.checks.push('100,000 added chat/raw records, 50,000 viewer records, and 20,000 activity buckets remain logically exact');
  await writeFile(new URL('integrated-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({checks:report.checks,timing:report.timing,sizes:report.sizes},null,2));
} catch(error) {
  // PostgreSQL error details may contain fixture values. Never print them.
  console.error({code:error.code,message:error.message});process.exitCode=1;
} finally {for(const client of clients) await client.end();}
