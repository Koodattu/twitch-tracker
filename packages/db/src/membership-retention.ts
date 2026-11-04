import { sql } from "drizzle-orm";
import type { DbClient } from "./index.js";

export async function rollupExpiredMembership(db: DbClient, maxContexts = 50) {
  let events = 0;
  let summaries = 0;
  let contexts = 0;
  for (; contexts < maxContexts; contexts++) {
    const result = await db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '2s'`);
      await tx.execute(sql`set local statement_timeout = '60s'`);
      await tx.execute(sql`set local timezone = 'UTC'`);
      return (await tx.execute<{ result: { context: number | null; events: number; summaries: number } }>(
        sql`select rollup_expired_membership() as result`
      )).rows[0]!.result;
    });
    if (result.context == null) break;
    events += result.events;
    summaries += result.summaries;
  }
  return { contexts, events, summaries };
}
