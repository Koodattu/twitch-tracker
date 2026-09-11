import { sql } from "drizzle-orm";
import type { CommunityBuildClaim, DbClient } from "@twitch-tracker/db";
import { communityMapThresholds, type CommunityCoverage } from "@twitch-tracker/shared";
import { maxCommunityMemberships } from "./community-graph.js";
import { readCommunityPresence } from "./community-presence.js";

export async function readCommunityInput(db: DbClient, claim: CommunityBuildClaim) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local statement_timeout = '90s'`);
    await tx.execute(sql`set local work_mem = '32MB'`);
    const observed = sql`
      with observed as materialized (
        select m.chatter_user_id, m.broadcaster_user_id, m.received_at,
          m.twitch_stream_id is null as missing_session,
          coalesce(s.is_finnish_eligible, false) as finnish,
          m.shared_chat_source_channel_id is not null and m.shared_chat_source_channel_id <> m.broadcaster_user_id as relayed,
          m.shared_chat_source_channel_id is not null or (
            coalesce(r.unrelayed_source,
              r.raw_line like '@%' and split_part(r.raw_line, ' ', 1) !~ '(?:^@|;)source-room-id=[^;]+')
          ) as known_source,
          not exists (select 1 from subject_privacy_states p
            where p.twitch_user_id = m.chatter_user_id
              and (p.public_profile_hidden or p.tracking_opted_out or p.data_deleted_at is not null))
          and not exists (select 1 from subject_privacy_states p
            where p.twitch_user_id = m.broadcaster_user_id
              and (p.public_profile_hidden or p.tracking_opted_out or p.data_deleted_at is not null))
          and not exists (select 1 from bot_accounts b where b.twitch_user_id = m.chatter_user_id) as permitted
        from chat_messages m
        left join stream_sessions s on s.twitch_stream_id = m.twitch_stream_id and s.broadcaster_user_id = m.broadcaster_user_id
        left join raw_irc_messages r on r.id = m.raw_irc_message_id and m.shared_chat_source_channel_id is null
        where m.received_at >= ${claim.windowStart} and m.received_at < ${claim.windowEnd}
      )
    `;
    const members = await tx.execute<{ chatterId: string; channelId: string; first: string; last: string }>(sql`
      ${observed}
      select chatter_user_id as "chatterId", broadcaster_user_id as "channelId", min(received_at) as first, max(received_at) as last
      from observed where finnish and permitted and known_source and not relayed and chatter_user_id is not null
      group by chatter_user_id, broadcaster_user_id having count(*) >= 3
      order by chatter_user_id, broadcaster_user_id limit ${maxCommunityMemberships + 1}
    `);
    if (members.rows.length > maxCommunityMemberships) throw new Error("Community membership budget exceeded");
    const diagnostics = await tx.execute<{ messages: number; missingSession: number; unknownSource: number; relayedMessages: number }>(sql`
      ${observed}
      select count(*)::int as messages,
        count(*) filter (where missing_session)::int as "missingSession",
        count(*) filter (where finnish and permitted and not coalesce(known_source, false))::int as "unknownSource",
        count(*) filter (where finnish and permitted and relayed)::int as "relayedMessages"
      from observed
    `);
    const presence = await readCommunityPresence(tx, claim);
    const combined = new Map(members.rows.map((row) => [`${row.chatterId}\0${row.channelId}`, { ...row, weight: 1 }]));
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
    const coverage: CommunityCoverage = { ...diagnostics.rows[0]!, thresholds: communityMapThresholds, qualifyingMemberships: combined.size, presence: presence.coverage,
      firstObservedAt: first?.toISOString() ?? null, lastObservedAt: last?.toISOString() ?? null };
    return { memberships: [...combined.values()].map(({ chatterId, channelId, weight }) => ({ chatterId, channelId, weight })), coverage };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
