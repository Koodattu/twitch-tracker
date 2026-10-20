import { sql } from "drizzle-orm";
import type { CommunityBuildClaim, DbClient } from "@twitch-tracker/db";
import type { CommunityCoverage } from "@twitch-tracker/shared";
import { maxCommunityMemberships } from "./community-graph.js";

export async function readCommunityPresence(db: Pick<DbClient, "execute">, claim: CommunityBuildClaim) {
  const result = await db.execute<{
    members: Array<{ chatterId: string; channelId: string; first: string; last: string }>;
    events: number; unresolvedEvents: number; recoveredEvents: number; observedChannels: number; snapshotChannels: number;
  }>(sql`
    with evidence as materialized (
      -- Deduplicate compact identities before decoding: repeated messages add no
      -- evidence, but different IDs on the same login/day must remain ambiguous.
      select lower(chatter_login) as login, (received_at at time zone 'UTC')::date as day, chatter_user_id as id
      from chat_messages where received_at >= ${claim.windowStart} and received_at < ${claim.windowEnd}
        and chatter_login is not null and chatter_user_id is not null
      union
      select lower(chatter_login), (observed_at at time zone 'UTC')::date, encode_external_key(chatter_user_id)
      from chat_presence_observations where observed_at >= ${claim.windowStart} and observed_at < ${claim.windowEnd}
        and chatter_login is not null and chatter_user_id is not null
    ), identities as materialized (
      select login, day, decode_external_key((array_agg(id))[1]) as id
      from evidence group by login, day having count(*) = 1
    ), events as materialized (
      select coalesce(identity.chatter_user_id, i.id) as person, c.broadcaster_user_id as channel,
        m.received_at as observed, identity.chatter_user_id is null and i.id is not null as recovered, false as snapshot
      from membership_events m
      join membership_event_contexts c on c.id = m.context_id
      join membership_event_identities identity on identity.id = m.identity_id
      join stream_sessions s on s.twitch_stream_id = c.twitch_stream_id and s.broadcaster_user_id = c.broadcaster_user_id
      left join identities i on identity.chatter_user_id is null and i.login = lower(identity.chatter_login)
        and i.day = (m.received_at at time zone 'UTC')::date
      where m.received_at >= ${claim.windowStart} and m.received_at < ${claim.windowEnd}
        and s.is_finnish_eligible and m.received_at >= s.started_at
        and (s.ended_at is null or m.received_at <= s.ended_at)
        -- The view reconstructs the default source with coalesce, hiding its
        -- statistics. NULL is exactly irc_membership; non-defaults start with !.
        and m.source_override is null
      union all
      select p.chatter_user_id, p.broadcaster_user_id, p.observed_at, false, true
      from chat_presence_observations p
      join chat_presence_snapshots snap on snap.id = p.snapshot_id
        and snap.broadcaster_user_id = p.broadcaster_user_id and snap.twitch_stream_id = p.twitch_stream_id
      join stream_sessions s on s.twitch_stream_id = p.twitch_stream_id and s.broadcaster_user_id = p.broadcaster_user_id
      where p.observed_at >= ${claim.windowStart} and p.observed_at < ${claim.windowEnd}
        and s.is_finnish_eligible and p.observed_at >= s.started_at
        and (s.ended_at is null or p.observed_at <= s.ended_at)
        and snap.request_status in ('succeeded', 'truncated') and p.source = 'helix.get_chatters'
    ), permitted as materialized (
      select * from events e where person is not null
        and not exists (select 1 from subject_privacy_states p where p.twitch_user_id = e.person
          and (p.public_profile_hidden or p.tracking_opted_out or p.data_deleted_at is not null))
        and not exists (select 1 from subject_privacy_states p where p.twitch_user_id = e.channel
          and (p.public_profile_hidden or p.tracking_opted_out or p.data_deleted_at is not null))
        and not exists (select 1 from bot_accounts b where b.twitch_user_id = e.person)
    ), widespread as (
      select person from permitted group by person having count(distinct channel) > 50
    ), qualified as (
      select person as "chatterId", channel as "channelId", min(observed) as first, max(observed) as last
      from permitted where person not in (select person from widespread)
      group by person, channel having count(distinct (observed at time zone 'UTC')::date) >= 2
        and max(observed) - min(observed) >= interval '6 hours'
      order by person, channel limit ${maxCommunityMemberships + 1}
    )
    select coalesce((select jsonb_agg(q) from qualified q), '[]'::jsonb) as members,
      count(*)::int as events, count(*) filter (where person is null)::int as "unresolvedEvents",
      count(*) filter (where recovered)::int as "recoveredEvents",
      count(distinct channel)::int as "observedChannels",
      count(distinct channel) filter (where snapshot)::int as "snapshotChannels" from events
  `);
  const { members, ...diagnostics } = result.rows[0]!;
  if (members.length > maxCommunityMemberships) throw new Error("Community membership budget exceeded");
  const coverage: NonNullable<CommunityCoverage["presence"]> = {
    ...diagnostics, qualifyingMemberships: members.length, presenceOnlyMemberships: 0
  };
  return { members, coverage };
}
