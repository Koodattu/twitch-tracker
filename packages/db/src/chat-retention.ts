import { sql } from "drizzle-orm";
import type { DbClient } from "./index.js";

export async function expireChatWire(db: DbClient, batchSize = 1000) {
  return db.transaction(async tx => {
    await tx.execute(sql`set local lock_timeout = '2s'`);
    await tx.execute(sql`set local statement_timeout = '60s'`);
    return (await tx.execute<{ count: number }>(sql`
      select expire_chat_wire_batch(date_trunc('day',now(),'UTC')-interval '30 days',${batchSize}) as count
    `)).rows[0]!.count;
  });
}
