import {readFile, writeFile} from 'node:fs/promises';

// Generates aggregate-only, read-only SQL. Constants stand for dictionary keys;
// this measures a layout, not a working schema or a lossless implementation.
const here = new URL('./', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('production-catalog.json', here), 'utf8'));
const names = ['chat_messages', 'stream_snapshots', 'raw_irc_messages', 'membership_events',
  'membership_event_identities', 'stream_activity_buckets'];
const userKeys = new Set(['broadcaster_user_id', 'chatter_user_id', 'shared_chat_source_channel_id']);
const streamKeys = new Set(['twitch_stream_id']);
const fixedAlignment = type => type.includes('timestamp') || type === 'bigint' ? 8
  : ['integer', 'uuid', 'raw_processing_status'].includes(type) ? 4 : type === 'smallint' ? 2
  : type === 'boolean' ? 1 : 0;
const compactTime = (name, anchor, optional) => {
  const delta = `(CASE WHEN isfinite(${name}) AND isfinite(${anchor}) THEN extract(epoch FROM (${name}-${anchor}))*1000000 END)`;
  const fits = `(isfinite(${name}) AND isfinite(${anchor}) AND ${delta} BETWEEN -2147483648 AND 2147483647)`;
  return [
    {name:name+'_delta', type:'integer', expression:`CASE WHEN ${fits} THEN ${optional ? delta+'::int' : 'nullif('+delta+'::int,0)'} END`},
    {name:name+'_full', type:'timestamp with time zone', expression:`CASE WHEN NOT coalesce(${fits},false) THEN ${name} END`}
  ];
};
const queries = names.flatMap(table => {
  const columns = catalog.columns.filter(c => c.table === table && !c.dropped);
  const original = columns.map(c => ({...c, expression:c.name}));
  const keys = original.map(c => userKeys.has(c.name) || streamKeys.has(c.name)
    ? {...c,type:'integer',expression:`CASE WHEN ${c.name} IS NOT NULL THEN 1::int END`} : c);
  const compact = keys.flatMap(c => {
    if (c.name === 'created_at') return compactTime(c.name,
      table === 'stream_activity_buckets' ? 'bucket_start' : table === 'stream_snapshots' ? 'observed_at' : 'received_at', false);
    if (c.name === 'updated_at') return compactTime(c.name,'created_at',false);
    if (table === 'membership_events' && ['checked_at_override','updated_at_override'].includes(c.name))
      return compactTime(c.name,c.name === 'checked_at_override' ? 'received_at' : 'created_at',true);
    if (table === 'membership_events' && ['event_time_kind','identity_time_kind','is_join'].includes(c.name)) return [];
    if (table === 'membership_events' && c.name === 'digest_slot') return {...c,expression:'nullif(digest_slot,0)'};
    if (table === 'raw_irc_messages' && c.name === 'payload_block_id')
      return {...c,type:'integer',expression:'CASE WHEN payload_block_id IS NOT NULL THEN 1::int END'};
    if (table === 'raw_irc_messages' && c.name === 'raw_line') return {...c,expression:"nullif(raw_line,'')"};
    if (table === 'raw_irc_messages' && c.name === 'processing_status') return {...c,expression:"nullif(processing_status,'processed')"};
    if ((table === 'chat_messages' && ['badges','emotes'].includes(c.name)) || (table === 'raw_irc_messages' && c.name === 'tags'))
      return {...c,expression:`nullif(${c.name},decode('00','hex'))`};
    if (table === 'chat_messages' && c.name === 'chatter_login')
      return {...c,type:'integer',expression:'CASE WHEN chatter_login IS NOT NULL THEN 1::int END'};
    if (table === 'chat_messages' && c.name === 'source') return {...c,expression:"nullif(source,'irc')"};
    if (table === 'chat_messages' && c.name === 'message_type') return {...c,expression:"nullif(message_type,'privmsg')"};
    if (table === 'stream_snapshots' && c.name === 'tags') return {...c,expression:"nullif(tags,'[]'::jsonb)"};
    return c;
  });
  if (table === 'membership_events') compact.push({name:'flags',type:'smallint',expression:'1::smallint'});
  compact.sort((a,b) => fixedAlignment(b.type)-fixedAlignment(a.type));
  const row = cols => 'ROW('+cols.map(c => c.expression).join(',')+')';
  const avgAligned = value => `avg(ceil(pg_column_size(${value})/8.0)*8+4)`;
  const statement = `WITH sample AS MATERIALIZED (
    SELECT * FROM public.${table} TABLESAMPLE SYSTEM (0.08) REPEATABLE (__SEED__) LIMIT 20000
  ) SELECT jsonb_build_object('table','${table}','sample_seed',__SEED__,'sample_rows',count(*),
    'actual_tuple_bytes',avg(pg_column_size(s)),
    'actual_aligned_bytes',${avgAligned('s')},
    'original_aligned_bytes',${avgAligned(row(original))},
    'keys_aligned_bytes',${avgAligned(row(keys))},
    'compact_aligned_bytes',${avgAligned(row(compact))}
    ${columns.some(c=>c.name==='updated_at') ? ", 'updated_equals_created_fraction',avg((updated_at=created_at)::int)" : ''}
    ${columns.some(c=>c.name==='created_at') && columns.some(c=>c.name==='received_at') ? ", 'created_equals_received_fraction',avg((created_at=received_at)::int)" : ''}
    ${table==='raw_irc_messages' ? ", 'archived_fraction',avg((payload_block_id IS NOT NULL)::int), 'max_payload_block_id_in_sample',max(payload_block_id)" : ''}
  ) FROM sample s;`;
  return [7102026,8102026,9102026].map(seed=>statement.replaceAll('__SEED__',String(seed)));
});
await writeFile(new URL('widths.sql', here), 'BEGIN READ ONLY;\n'+queries.join('\n')+'\nCOMMIT;\n');
