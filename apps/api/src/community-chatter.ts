import { and, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { communityMapSnapshots, communityMapState, type DbClient } from "@twitch-tracker/db";
import type { CommunityChatterActivity } from "@twitch-tracker/shared";

/** Private lookup over the published window, using only observations tied to a stable account ID. */
export async function getCommunityChatterActivity(db: DbClient, login: string, expectedMap?: string): Promise<CommunityChatterActivity> {
  return db.transaction(async tx => {
    await tx.execute(sql`set local statement_timeout = '8s'`);
    const [result] = await tx.select({ snapshot: communityMapSnapshots }).from(communityMapState)
      .innerJoin(communityMapSnapshots, and(eq(communityMapState.snapshotId, communityMapSnapshots.id),
        eq(communityMapState.privacyVersion, communityMapSnapshots.privacyVersion), eq(communityMapSnapshots.valid, true)))
      .where(eq(communityMapState.id, "current"));
    const snapshot = result?.snapshot;
    if (snapshot?.graph == null) throw new HTTPException(503, { message: "The community map is unavailable." });
    if (expectedMap != null && expectedMap !== snapshot.generatedAt.toISOString()) {
      throw new HTTPException(409, { message: "The community map has changed. Reload before searching." });
    }
    const user = (await tx.execute<{ id: string; login: string; displayName: string | null }>(sql`
      select u.twitch_user_id as id, u.login, u.display_name as "displayName" from twitch_users u
      where u.login = ${login} and not exists (
        select 1 from subject_privacy_states p where p.twitch_user_id = u.twitch_user_id
          and (p.public_profile_hidden or p.tracking_opted_out or p.data_deleted_at is not null)
      ) and not exists (select 1 from bot_accounts b where b.twitch_user_id = u.twitch_user_id)
    `)).rows[0];
    if (user == null) throw new HTTPException(404, { message: "No available activity for that username." });
    const ids = snapshot.graph.nodes.map(node => node.id);
    const channelIds = sql`array[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]::text[]`;
    const activity = ids.length === 0 ? [] : (await tx.execute<CommunityChatterActivity["channels"][number]>(sql`
      with messages as (
        select m.broadcaster_user_id as channel, count(*)::int as messages,
          count(distinct (m.received_at at time zone 'UTC')::date)::int as days, max(m.received_at) as last
        from chat_messages m
        join stream_sessions s on s.twitch_stream_id = m.twitch_stream_id and s.broadcaster_user_id = m.broadcaster_user_id
        left join raw_irc_messages r on r.id = m.raw_irc_message_id and m.shared_chat_source_channel_id is null
        where m.chatter_user_id = ${user.id} and m.received_at >= ${snapshot.windowStart} and m.received_at < ${snapshot.windowEnd}
          and s.is_finnish_eligible and m.broadcaster_user_id = any(${channelIds})
          and not exists (select 1 from subject_privacy_states p where p.twitch_user_id = m.broadcaster_user_id
            and (p.public_profile_hidden or p.tracking_opted_out or p.data_deleted_at is not null))
          and (m.shared_chat_source_channel_id = m.broadcaster_user_id or (m.shared_chat_source_channel_id is null
            and coalesce(r.unrelayed_source, r.raw_line like '@%' and split_part(r.raw_line, ' ', 1) !~ '(?:^@|;)source-room-id=[^;]+')))
        group by m.broadcaster_user_id
      ), presence_events as (
        select m.broadcaster_user_id as channel, m.received_at as observed from chat_membership_events m
        join stream_sessions s on s.twitch_stream_id = m.twitch_stream_id and s.broadcaster_user_id = m.broadcaster_user_id
        where m.chatter_user_id = ${user.id} and m.received_at >= ${snapshot.windowStart} and m.received_at < ${snapshot.windowEnd}
          and s.is_finnish_eligible and m.received_at >= s.started_at and (s.ended_at is null or m.received_at <= s.ended_at)
          and m.source = encode_common_label('irc_membership', 'irc_membership')
        union all
        select p.broadcaster_user_id, p.observed_at from chat_presence_observations p
        join chat_presence_snapshots snap on snap.id = p.snapshot_id
          and snap.broadcaster_user_id = p.broadcaster_user_id and snap.twitch_stream_id = p.twitch_stream_id
        join stream_sessions s on s.twitch_stream_id = p.twitch_stream_id and s.broadcaster_user_id = p.broadcaster_user_id
        where p.chatter_user_id = ${user.id} and p.observed_at >= ${snapshot.windowStart} and p.observed_at < ${snapshot.windowEnd}
          and s.is_finnish_eligible and p.observed_at >= s.started_at and (s.ended_at is null or p.observed_at <= s.ended_at)
          and snap.request_status in ('succeeded', 'truncated') and p.source = 'helix.get_chatters'
      ), permitted_presence as materialized (
        select e.* from presence_events e where not exists (
          select 1 from subject_privacy_states p where p.twitch_user_id = e.channel
            and (p.public_profile_hidden or p.tracking_opted_out or p.data_deleted_at is not null)
        )
      ), presence as (
        select channel, count(distinct (observed at time zone 'UTC')::date)::int as days, max(observed) as last
        from permitted_presence where channel = any(${channelIds})
          and (select count(distinct channel) from permitted_presence) <= 50
        group by channel having count(distinct (observed at time zone 'UTC')::date) >= 2
          and max(observed) - min(observed) >= interval '6 hours'
      )
      select coalesce(m.channel, p.channel) as "channelId", coalesce(m.messages, 0) as messages,
        coalesce(m.days, 0) as "messageDays", coalesce(p.days, 0) as "presenceDays",
        greatest(m.last, p.last) as "lastObservedAt"
      from messages m full join presence p on p.channel = m.channel
      where m.messages >= 3 or p.days >= 2
      order by messages desc, "presenceDays" desc, "channelId"
    `)).rows;
    return { login: user.login, displayName: user.displayName, mapGeneratedAt: snapshot.generatedAt.toISOString(),
      windowStart: snapshot.windowStart.toISOString(), windowEnd: snapshot.windowEnd.toISOString(),
      channels: activity.map(channel => ({ ...channel, lastObservedAt: new Date(channel.lastObservedAt).toISOString() })) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
