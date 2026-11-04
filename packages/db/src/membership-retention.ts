import { sql } from "drizzle-orm";
import type { DbClient } from "./index.js";

export async function rollupExpiredMembership(db: DbClient, maxContexts = 50) {
  let events = 0;
  let summaries = 0;
  let contexts = 0;
  while (contexts < maxContexts) {
    const result = await db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`set local statement_timeout = '60s'`);
      await tx.execute(sql`set local timezone = 'UTC'`);
      return (await tx.execute<{ result: { context: number | null; contexts: number; events: number; summaries: number } }>(
        sql`select rollup_expired_membership_batch(date_trunc('day',now(),'UTC')-interval '7 days',${Math.min(25,maxContexts-contexts)}) as result`
      )).rows[0]!.result;
    });
    if (result.context == null) break;
    contexts += result.contexts;
    events += result.events;
    summaries += result.summaries;
  }
  return { contexts, events, summaries };
}

export async function expireMembershipWire(db: DbClient) {
  return db.transaction(async tx => {
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '60s'`);
    return (await tx.execute<{ count: number }>(sql`
      select expire_membership_wire_batch(date_trunc('day',now(),'UTC')-interval '7 days',5000) as count
    `)).rows[0]!.count;
  });
}
