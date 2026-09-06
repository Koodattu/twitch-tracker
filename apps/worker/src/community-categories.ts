import { sql } from "drizzle-orm";
import type { CommunityBuildClaim, DbClient } from "@twitch-tracker/db";
import type { CommunityGraph } from "@twitch-tracker/shared";

export async function addCommunityCategories(db: Pick<DbClient, "transaction">, claim: CommunityBuildClaim, graph: CommunityGraph) {
  if (graph.nodes.length === 0) return;
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '30s'`);
    await tx.execute(sql`set local work_mem = '32MB'`);
    return tx.execute<{ channel: string; id: string; name: string; share: number }>(sql`
      with sessions as materialized (
        select s.*, greatest(s.first_seen_at, s.started_at, ${claim.windowStart}) as window_start,
          least(coalesce(s.ended_at, s.last_seen_live_at), ${claim.windowEnd}) as window_end
        from stream_sessions s where s.is_finnish_eligible
          and s.broadcaster_user_id in (select jsonb_array_elements_text(${JSON.stringify(graph.nodes.map((node) => node.id))}::jsonb))
          and s.started_at < ${claim.windowEnd} and coalesce(s.ended_at, s.last_seen_live_at) > ${claim.windowStart}
      ), points as (
        select twitch_stream_id as stream, broadcaster_user_id as channel, greatest(first_seen_at, started_at) as observed,
          initial_category_id as category, initial_category_name as name, 0 as priority from sessions
        union all
        select p.twitch_stream_id, p.broadcaster_user_id, p.observed_at, p.category_id, p.category_name, 1
        from stream_snapshots p join sessions s on s.twitch_stream_id = p.twitch_stream_id and s.broadcaster_user_id = p.broadcaster_user_id
        where p.category_id is not null and p.observed_at >= greatest(s.first_seen_at, s.started_at) and p.observed_at < s.window_end
      ), changes as (
        select distinct on (stream, observed) * from points order by stream, observed, priority desc, category, name
      ), intervals as (
        select *, lead(observed) over (partition by stream order by observed) as next_observed from changes
      ), durations as (
        select p.channel, p.category, p.name, p.observed,
          greatest(0, extract(epoch from (least(coalesce(p.next_observed, s.window_end), s.window_end) - greatest(p.observed, s.window_start)))) as seconds
        from intervals p join sessions s on s.twitch_stream_id = p.stream
      ), categories as (
        select channel, category as id, (array_agg(name order by observed desc))[1] as name, sum(seconds) as seconds
        from durations where nullif(category, '') is not null and nullif(name, '') is not null
        group by channel, category
      ), ranked as (
        select *, row_number() over (partition by channel order by seconds desc, id) as rank,
          sum(seconds) over (partition by channel) as known_seconds from categories
      ), totals as (
        select broadcaster_user_id as channel, sum(greatest(0,extract(epoch from (window_end - window_start)))) as seconds
        from sessions group by broadcaster_user_id
      )
      select r.channel, r.id, r.name, (r.seconds / r.known_seconds)::float8 as share from ranked r join totals t using (channel)
      where r.rank = 1 and r.known_seconds > 0 and r.known_seconds >= t.seconds * 0.5
    `);
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  const categories = new Map(result.rows.map(({ channel, ...category }) => [channel, category]));
  for (const node of graph.nodes) {
    const category = categories.get(node.id);
    if (category != null) node.category = category;
  }
}
