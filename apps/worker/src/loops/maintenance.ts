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

      return {
        rawPayloadRetentionDays,
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
