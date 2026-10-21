import { sql } from "drizzle-orm";
import type { CommunityBuildClaim, DbClient } from "@twitch-tracker/db";
import { communityMapThresholds, type CommunityCoverage } from "@twitch-tracker/shared";
import { maxCommunityMemberships } from "./community-graph.js";
import { readCommunityPresence } from "./community-presence.js";

export async function readCommunityInput(db: DbClient, claim: CommunityBuildClaim) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '180s'`);
    await tx.execute(sql`set local work_mem = '32MB'`);
    const result = await tx.execute<{
      members: Array<{ chatterId: string; channelId: string; first: string; last: string }>;
      messages: number; missingSession: number; unknownSource: number; relayedMessages: number;
    }>(sql`
      with observed as (
        select m.chatter_user_id, m.broadcaster_user_id, m.received_at,
          m.twitch_stream_id is null as missing_session,
          coalesce(s.is_finnish_eligible, false) as finnish,
          m.shared_chat_source_channel_id is not null and m.shared_chat_source_channel_id <> m.broadcaster_user_id as relayed,
          m.shared_chat_source_channel_id is not null or (
            coalesce(r.unrelayed_source,
              r.raw_line like '@%' and split_part(r.raw_line, ' ', 1) !~ '(?:^@|;)source-room-id=[^;]+')
          ) as known_source
        from chat_messages m
        left join stream_sessions s on s.storage_key = m.twitch_stream_id and encode_external_key(s.broadcaster_user_id) = m.broadcaster_user_id
        left join raw_irc_messages r on r.id = m.raw_irc_message_id and m.shared_chat_source_channel_id is null
        where m.received_at >= ${claim.windowStart} and m.received_at < ${claim.windowEnd}
      ), grouped as materialized (
        -- Privacy is constant per person/channel in this repeatable-read snapshot.
        -- Apply it after grouping, avoiding per-message correlated predicates and
        -- materialization of millions of joined message rows.
        select chatter_user_id, broadcaster_user_id,
          min(received_at) filter (where finnish and known_source and not relayed) as first,
          max(received_at) filter (where finnish and known_source and not relayed) as last,
          count(*) filter (where finnish and known_source and not relayed) as qualifying,
          count(*) as messages,
          count(*) filter (where missing_session) as missing_session,
          count(*) filter (where finnish and not coalesce(known_source, false)) as unknown_source,
          count(*) filter (where finnish and relayed) as relayed_messages
        from observed group by chatter_user_id, broadcaster_user_id
      ), classified as materialized (
        select g.*,
          not exists (select 1 from subject_privacy_states p
            where encode_external_key(p.twitch_user_id) = g.chatter_user_id
              and (p.public_profile_hidden or p.tracking_opted_out or p.data_deleted_at is not null))
          and not exists (select 1 from subject_privacy_states p
            where encode_external_key(p.twitch_user_id) = g.broadcaster_user_id
              and (p.public_profile_hidden or p.tracking_opted_out or p.data_deleted_at is not null))
          and not exists (select 1 from bot_accounts b where encode_external_key(b.twitch_user_id) = g.chatter_user_id) as permitted
        from grouped g
      ), members as (
        select decode_external_key(chatter_user_id) as "chatterId",
          decode_external_key(broadcaster_user_id) as "channelId", first, last
        from classified where permitted and qualifying >= 3 and chatter_user_id is not null
        order by "chatterId", "channelId" limit ${maxCommunityMemberships + 1}
      )
      select coalesce((select jsonb_agg(m) from members m), '[]'::jsonb) as members,
        coalesce(sum(messages), 0)::int as messages,
        coalesce(sum(missing_session), 0)::int as "missingSession",
        coalesce(sum(unknown_source) filter (where permitted), 0)::int as "unknownSource",
        coalesce(sum(relayed_messages) filter (where permitted), 0)::int as "relayedMessages"
      from classified
    `);
    const { members, ...diagnostics } = result.rows[0]!;
    if (members.length > maxCommunityMemberships) throw new Error("Community membership budget exceeded");
    // The 30-day presence query measured 113 seconds in production. Allow
    // the 60-day scan more headroom within the ten-minute build budget.
    await tx.execute(sql`set local statement_timeout = '300s'`);
    const presence = await readCommunityPresence(tx, claim);
    const combined = new Map(members.map((row) => [`${row.chatterId}\0${row.channelId}`, { ...row, weight: 1 }]));
    for (const row of presence.members) {
      const key = `${row.chatterId}\0${row.channelId}`;
      if (!combined.has(key)) {
        combined.set(key, { ...row, weight: 0.25 });
        presence.coverage.presenceOnlyMemberships++;
      }
    }
    if (combined.size > maxCommunityMemberships) throw new Error("Community membership budget exceeded");
    let first: Date | null = null, last: Date | null = null;
    for (const row of combined.values()) {
      const rowFirst = new Date(row.first), rowLast = new Date(row.last);
      if (first == null || rowFirst < first) first = rowFirst;
      if (last == null || rowLast > last) last = rowLast;
    }
    const coverage: CommunityCoverage = { ...diagnostics, thresholds: communityMapThresholds, qualifyingMemberships: combined.size, presence: presence.coverage,
      firstObservedAt: first?.toISOString() ?? null, lastObservedAt: last?.toISOString() ?? null };
    return { memberships: [...combined.values()].map(({ chatterId, channelId, weight }) => ({ chatterId, channelId, weight })), coverage };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
