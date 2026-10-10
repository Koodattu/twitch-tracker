import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';

const read = async name => JSON.parse(await readFile(new URL(name,import.meta.url),'utf8'));
const catalog = await read('production-catalog.json');
const widths = await read('production-widths.json');
const physical = await read('keys-results.json');
assert.ok(physical.checks.length === 3 && physical.checks.every(c=>c.passed));
const gib = bytes => bytes / 2**30;
const indexDelta = (physical.index_control.text_bytes-physical.index_control.integer_bytes)/physical.index_control.rows;
const indexCounts = {chat_messages:3,stream_snapshots:2,stream_activity_buckets:1,membership_event_identities:2};
const groups = [...new Set(widths.map(r=>r.table))].map(table=>{
  const samples = widths.filter(r=>r.table===table);
  assert.equal(samples.length,3);
  for (const s of samples) {
    assert.ok(s.sample_rows>0 && s.sample_rows<20000,'Capped sample would bias this projection');
  }
  const count = samples.reduce((n,s)=>n+s.sample_rows,0);
  const mean = field=>samples.reduce((n,s)=>n+s.sample_rows*s[field],0)/count;
  const r = catalog.relations.find(r=>r.name===table);
  // A reconstructed ROW can differ from the stored tuple. Use the smaller
  // baseline, so that discrepancy cannot be counted as compaction savings.
  const baseline = samples.reduce((n,s)=>n+s.sample_rows*Math.min(s.original_aligned_bytes,s.actual_aligned_bytes),0)/count;
  const heapKeys = baseline-mean('keys_aligned_bytes');
  const heapCompact = baseline-mean('compact_aligned_bytes');
  // This deliberately overcredits membership identities: one index is partial
  // and duplicate keys can share posting tuples. Treat its index credit as 0..max.
  const indexes = (indexCounts[table]??0)*indexDelta;
  return {table,sample_rows:count,production_row_estimate:r.live_rows_estimate,
    alternative_row_estimate:r.estimated_rows,
    heap_key_bytes_saved_per_row:heapKeys,heap_compact_bytes_saved_per_row:heapCompact,
    index_bytes_saved_per_row:indexes,index_credit_is_upper_estimate:table==='membership_event_identities',
    baseline_model_minus_actual_avg_bytes:mean('original_aligned_bytes')-mean('actual_aligned_bytes'),
    keys_gross_gib:gib((heapKeys+indexes)*r.live_rows_estimate),
    compact_gross_gib:gib((heapCompact+indexes)*r.live_rows_estimate),
    heap_compact_per_row_seed_range:samples.map(s=>s.original_aligned_bytes-s.compact_aligned_bytes).sort((a,b)=>a-b)};
});
const dictionaryCharge = Object.entries({users:'twitch_users',streams:'stream_sessions'}).map(([dict,table])=>{
  const d = physical.dictionaries[dict],rows = catalog.relations.find(r=>r.name===table).live_rows_estimate;
  return {table,estimated_rows:rows,bytes_per_dictionary_row:d.total_bytes/d.rows,
    projected_bytes:d.total_bytes/d.rows*rows+d.sequence_bytes};
});
const dictionaryBytes = dictionaryCharge.reduce((n,d)=>n+d.projected_bytes,0);
const sum = field=>groups.reduce((n,g)=>n+g[field],0);
const identityCredit = gib(groups.find(g=>g.table==='membership_event_identities').production_row_estimate*2*indexDelta);
const conservativeDensity = gib(groups.reduce((n,g)=>n+g.production_row_estimate*
  (g.heap_compact_bytes_saved_per_row/0.9+g.index_bytes_saved_per_row*0.9/0.7),0));
const alternateCounts = gib(groups.reduce((n,g)=>n+g.alternative_row_estimate*
  (g.heap_compact_bytes_saved_per_row+g.index_bytes_saved_per_row),0));
const report = {captured_at:catalog.captured_at,database_gib:gib(catalog.database_bytes),
  scope:'Six major native-row relations; raw wire blocks and response payload compression excluded',
  row_count_source:'pg_stat_user_tables.n_live_tup estimates; reltuples shown as sensitivity, not exact counts',
  sample_method:'Three fixed-seed SYSTEM(0.08) page samples per relation, aggregates only, each under the 20000-row cap',
  index_control_bytes_saved_per_row:indexDelta,groups,dictionary_charge:dictionaryCharge,
  keys_gross_gib:sum('keys_gross_gib'),
  keys_net_gib_range:[sum('keys_gross_gib')-gib(dictionaryBytes)-identityCredit,sum('keys_gross_gib')-gib(dictionaryBytes)],
  compact_gross_gib:sum('compact_gross_gib'),compact_gross_using_reltuples_gib:alternateCounts,
  compact_gross_density_sensitivity_gib:conservativeDensity,
  density_sensitivity:'Assumed 90% heap and 70% B-tree occupancy, not measured production bloat',
  compact_after_user_stream_maps_before_login_map_gib:sum('compact_gross_gib')-gib(dictionaryBytes),
  compact_login_dictionary_cost:'Not measured; historical login cardinality cannot safely be inferred from current user rows',
  combined_plan:{
    keys_net_gib_range:[sum('keys_gross_gib')-gib(dictionaryBytes)-identityCredit,sum('keys_gross_gib')-gib(dictionaryBytes)],
    additional_row_encoding_gross_gib:sum('compact_gross_gib')-sum('keys_gross_gib'),
    total_before_historical_login_maps_gib_range:[sum('compact_gross_gib')-gib(dictionaryBytes)-identityCredit,
      sum('compact_gross_gib')-gib(dictionaryBytes)],
    growth_assumption:'Same observation mix, widths, index occupancy and proportional dictionary growth; no calendar forecast',
    growth_scenarios:[1,2,3].map(multiplier=>({retained_history_multiplier:multiplier,
      savings_before_historical_login_maps_gib_range:[
        (sum('compact_gross_gib')-gib(dictionaryBytes)-identityCredit)*multiplier,
        (sum('compact_gross_gib')-gib(dictionaryBytes))*multiplier]})),
    marginal_gross_mib_per_million:groups.map(g=>({table:g.table,
      mib:(g.heap_compact_bytes_saved_per_row+g.index_bytes_saved_per_row)*1e6/2**20})),
    nonadditive_candidates:['Raw metadata blocks overlap with raw row compaction',
      'History blocks and posting pages are alternative chat/viewer layouts',
      'Existing production compaction is already in the baseline'],
    release_requirements:['Combined physical footprint including every dictionary/index/sequence',
      'No material history, diagnostics, ingestion or erasure regression on comparable workloads',
      'Exact values, uniqueness, source links, historical-login erasure and rollback preserved',
      'Encode new writes and migrate retained history; plan physical reclamation separately']},
  limitations:['Width model is not an implementation or an absolute bound on all possible encodings',
    'No production-scale latency, concurrent ingestion, erasure or migration benchmark',
    'No bloat-reclamation or deletion credit; original UUIDs and binary message IDs retained',
    'Physical fixture excludes FK/check validation on both sides; no FK correctness claim'],
  validation:{all_sample_columns_round_trip:physical.checks.reduce((n,c)=>n+(c.rows??0),0),distinct_external_spellings:true,
    physical_vs_model_max_mean_difference_bytes:Math.max(...widths.map(s=>Math.abs(s.original_aligned_bytes-s.actual_aligned_bytes))),
    baseline_uses_smaller_of_physical_and_model:true,no_sample_hit_cap:true,
    new_observation_exports:0,cumulative_prior_extracted_rows:29917,cumulative_prior_extracted_bytes:25117896}};
await writeFile(new URL('results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({database_gib:report.database_gib,keys_net_gib_range:report.keys_net_gib_range,
  compact_gross_gib:report.compact_gross_gib,compact_gross_using_reltuples_gib:alternateCounts,
  compact_gross_density_sensitivity_gib:conservativeDensity,dictionary_gib:gib(dictionaryBytes),
  compact_after_user_stream_maps_before_login_map_gib:report.compact_after_user_stream_maps_before_login_map_gib},null,2));
