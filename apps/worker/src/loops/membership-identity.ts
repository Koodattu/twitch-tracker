import { sql } from "drizzle-orm";
import type { DbClient } from "@twitch-tracker/db";
import type { WorkerContext } from "../worker.js";
import { resolvePrimaryBotCredentials } from "../bot-auth.js";
import { upsertTwitchUserMetadata } from "../twitch-user-metadata.js";
import { startIntervalLoop } from "./common.js";

// Only recent, explicitly refreshed metadata may identify an untagged IRC login.
export async function findMembershipIdentity(db: Pick<DbClient, "execute">, login: string | null, now: Date) {
  if (login == null) return null;
  const result = await db.execute<{ id: string }>(sql`
    select u.twitch_user_id as id from twitch_users u
    where u.login = ${login} and u.last_metadata_refresh_at >= ${new Date(now.getTime() - 3_600_000)}
      and not exists (select 1 from subject_privacy_states p where p.twitch_user_id = u.twitch_user_id
        and (p.tracking_opted_out or p.data_deleted_at is not null))
    limit 2
  `);
  return result.rows.length === 1 ? result.rows[0]!.id : null;
}

export async function resolveMembershipIdentities(context: WorkerContext) {
  if (!context.config.ENABLE_TWITCH_INGESTION || context.config.TWITCH_CLIENT_ID === "") return { skipped: "Twitch ingestion is disabled." };
  const now = new Date();
  const since = new Date(now.getTime() - 86_400_000);
  const pending = await context.db.execute<{ login: string }>(sql`
    select chatter_login as login from (
      select chatter_login, received_at from chat_membership_events
      where chatter_user_id is null and identity_checked_at is null and chatter_login is not null
        and received_at >= ${since} and received_at <= ${now}
      order by received_at limit 10000
    ) recent group by chatter_login order by min(received_at), chatter_login limit 100
  `);
  if (pending.rows.length === 0) return { checkedLogins: 0, resolvedEvents: 0 };
  const bot = await resolvePrimaryBotCredentials(context.db, context.config);
  if (bot.accessToken == null) return { skipped: "No bot access token is available." };
  const logins = pending.rows.map((row) => row.login);
  const response = await context.rest.getUsers({ logins, accessToken: bot.accessToken });
  // Leave events pending on transient errors and rate limits. Never log lookup payloads.
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Membership identity lookup failed (${response.statusCode})`);
  const users = response.responseJson.data.filter((user) => logins.includes(user.login));
  return context.db.transaction(async (tx) => {
    // Privacy completion takes an exclusive lock here before redacting data.
    await tx.execute(sql`select id from community_map_state where id = 'current' for share`);
    const restricted = await tx.execute<{ id: string }>(sql`
      select twitch_user_id as id from subject_privacy_states where tracking_opted_out or data_deleted_at is not null
    `);
    const blocked = new Set(restricted.rows.map((row) => row.id));
    const permitted = users.filter((user) => !blocked.has(user.id));
    for (const user of permitted) await upsertTwitchUserMetadata(tx, user, now);
    const resolved = await tx.execute<{ resolved: number }>(sql`
      with identities as (
        select * from jsonb_to_recordset(${JSON.stringify(permitted.map((user) => ({ login: user.login, id: user.id })))}::jsonb)
          as i(login text, id text)
      ), updated as (
        update chat_membership_events m set chatter_user_id = i.id, identity_checked_at = ${now}, updated_at = now()
        from (select requested.login, identities.id from jsonb_array_elements_text(${JSON.stringify(logins)}::jsonb) requested(login)
          left join identities using (login)) i
        where m.chatter_user_id is null and m.identity_checked_at is null and m.chatter_login = i.login
          and m.received_at >= ${since} and m.received_at <= ${now}
        returning m.chatter_user_id
      ) select count(chatter_user_id)::int as resolved from updated
    `);
    return { checkedLogins: logins.length, resolvedEvents: resolved.rows[0]!.resolved };
  });
}

export const runMembershipIdentityLoop = (context: WorkerContext) => startIntervalLoop({
  name: "membership-identity", intervalMs: 30_000, context, run: () => resolveMembershipIdentities(context)
});
