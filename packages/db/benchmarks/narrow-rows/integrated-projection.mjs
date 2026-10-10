import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';

// Aggregate only, over the existing local bounded fixtures. No remote connection.
const history=(await readFile(new URL('../../../../.cache/raw-metadata-bench/history_2.ndjson',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse);
const raw=(await readFile(new URL('../../../../.cache/raw-metadata-bench/sample_1.ndjson',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse);
const catalog=JSON.parse(await readFile(new URL('production-catalog.json',import.meta.url),'utf8'));
const measured=JSON.parse(await readFile(new URL('integrated-results.json',import.meta.url),'utf8'));
const rows=Object.fromEntries(catalog.relations.map(r=>[r.name,r.live_rows_estimate]));
const clients=['storage_baseline_test','storage_candidate_test'].map(database=>new pg.Client({host:'127.0.0.1',port:55438,user:'benchmark',database}));
const groups=[];
try {
  for(const c of clients)await c.connect();
  for(const [kind,logical,physical,key,type] of [
    ['chat','chat_messages','chat_message_records','twitch_message_id','bytea'],
    ['viewer','stream_snapshots','stream_snapshot_records','id','uuid'],
    ['raw','raw_irc_messages','raw_irc_records','id','uuid']
  ]) {
    const ids=kind==='raw'?raw.map(r=>r.id):history.filter(r=>r.kind===kind).map(r=>r.record[key]);
    const widths=[];
    for(let i=0;i<2;i++) {
      const result=(await clients[i].query(`select count(*)::int n,avg(ceil(pg_column_size(r)/8.0)*8+4)::float8 width from ${i?physical:logical} r where ${key}=any($1::${type}[])`,[ids])).rows[0];
      assert.equal(result.n,ids.length);widths.push(result.width);
    }
    const base=measured.sizes.sampleBaseline[logical],candidate=measured.sizes.sampleCombined[logical];
    const indexBytesPerRow=(base.indexes-candidate.indexes)/base.rows;
    groups.push({table:logical,sampleRows:ids.length,productionRowEstimate:rows[logical],baselineAlignedBytes:widths[0],candidateAlignedBytes:widths[1],
      heapBytesSavedPerRow:widths[0]-widths[1],indexBytesSavedPerRow:indexBytesPerRow,
      projectedBytesSaved:((widths[0]-widths[1])+indexBytesPerRow)*rows[logical]});
  }
  const base=measured.sizes.workloadBaseline,candidate=measured.sizes.workloadCombined;
  const bucket='stream_activity_buckets',bucketBytes=(base[bucket].total-candidate[bucket].total)/base[bucket].rows;
  groups.push({table:bucket,source:'20,000 synthetic rows',productionRowEstimate:rows[bucket],bytesSavedPerRow:bucketBytes,projectedBytesSaved:bucketBytes*rows[bucket]});
  const parentCosts=['twitch_users','stream_sessions'].map(table=>({table,productionRowEstimate:rows[table],bytesAddedPerRow:(candidate[table].total-base[table].total)/base[table].rows}));
  const cost=parentCosts.reduce((sum,c)=>sum+c.productionRowEstimate*c.bytesAddedPerRow,0);
  const net=groups.reduce((sum,g)=>sum+g.projectedBytesSaved,0)-cost;
  const result={catalogAt:catalog.captured_at,groups,parentCosts,projectedNetGiB:net/2**30,
    growthSameMixGiB:[1,2,3].map(scale=>scale*net/2**30),
    caveats:['Projection, not production disk savings. Row counts are estimates; the retained sample is not random.',
      'Small viewer indexes and synthetic activity buckets add uncertainty. No bloat, dead tuples, existing compression, or rejected block/posting savings are credited.',
      'Parent generated keys and their unique indexes are charged; there is no historical-login dictionary.']};
  await writeFile(new URL('integrated-projection.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally {for(const c of clients)await c.end();}
