import { createChatAssignmentControl } from "@twitch-tracker/db";
import { sql } from "drizzle-orm";
import type { WorkerContext } from "../worker.js";
import { startIntervalLoop } from "./common.js";

export const runMaintenanceLoop = (context: WorkerContext) => {
  const assignments = createChatAssignmentControl(context.db);

  return startIntervalLoop({
    name: "maintenance",
    intervalMs: context.config.MAINTENANCE_INTERVAL_MS,
    context,
    run: async () => {
      const rawPayloadRetentionDays = context.config.RAW_PAYLOAD_RETENTION_DAYS;
      const staleAssignmentGraceMinutes = context.config.STALE_ASSIGNMENT_GRACE_MINUTES;

      const redactedRawHelixResponses = await context.db.execute(sql`
        update raw_helix_responses
        set request_params = '{}'::jsonb,
            response_json = null,
            pagination = '{}'::jsonb,
            rate_limit_headers = '{}'::jsonb,
            updated_at = now()
        where status_code between 200 and 299
          and observed_at < now() - (${rawPayloadRetentionDays} * interval '1 day')
          and (
            request_params <> '{}'::jsonb
            or response_json is not null
            or pagination <> '{}'::jsonb
            or rate_limit_headers <> '{}'::jsonb
          )
      `);

      const closedStaleAssignments = await assignments.closeEndedStreams({
        graceMinutes: staleAssignmentGraceMinutes,
        observedAt: new Date()
      });

      const compactedRawIrcMessages = await context.db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.execute(sql`set local statement_timeout = '30s'`);
        let total = 0;
        for (let batch = 0; batch < 10; batch++) {
          const result = await tx.execute<{ count: number }>(sql`select compact_raw_irc_batch(now() - interval '1 day', 256) as count`);
          const count = result.rows[0]!.count;
          total += count;
          if (count === 0) break;
        }
        return total;
      });

      return {
        rawPayloadRetentionDays,
        compactedRawIrcMessages,
        staleAssignmentGraceMinutes,
        redactedRawHelixResponses: rowCount(redactedRawHelixResponses),
        closedStaleAssignments
      };
    }
  });
};

const rowCount = (result: unknown): number | null => {
  if (typeof result !== "object" || result == null || !("rowCount" in result)) {
    return null;
  }

  const value = (result as { rowCount?: unknown }).rowCount;
  return typeof value === "number" ? value : null;
};
