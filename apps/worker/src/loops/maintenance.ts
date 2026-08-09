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
      const rawChatRetentionDays = context.config.RAW_CHAT_RETENTION_DAYS;
      const rawPayloadRetentionDays = context.config.RAW_PAYLOAD_RETENTION_DAYS;
      const staleAssignmentGraceMinutes = context.config.STALE_ASSIGNMENT_GRACE_MINUTES;

      const redactedChatMessages = await context.db.execute(sql`
        update chat_messages
        set raw_text = null,
            updated_at = now()
        where raw_text is not null
          and received_at < now() - (${rawChatRetentionDays} * interval '1 day')
      `);

      const redactedRawIrcMessages = await context.db.execute(sql`
        update raw_irc_messages
        set raw_line = '[redacted by raw chat retention]',
            tags = '{}'::jsonb,
            parse_error = null,
            updated_at = now()
        where raw_line <> '[redacted by raw chat retention]'
          and received_at < now() - (${rawChatRetentionDays} * interval '1 day')
      `);

      const redactedRawEventSubEvents = await context.db.execute(sql`
        update raw_eventsub_events
        set payload = jsonb_build_object(
              'redacted', true,
              'reason', 'raw_payload_retention',
              'event_type', event_type
            ),
            updated_at = now()
        where not (payload @> '{"redacted": true}'::jsonb)
          and received_at < now() - (${rawPayloadRetentionDays} * interval '1 day')
      `);

      const redactedRawHelixResponses = await context.db.execute(sql`
        update raw_helix_responses
        set request_params = '{}'::jsonb,
            response_json = null,
            pagination = '{}'::jsonb,
            rate_limit_headers = '{}'::jsonb,
            updated_at = now()
        where observed_at < now() - (${rawPayloadRetentionDays} * interval '1 day')
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
        rawChatRetentionDays,
        rawPayloadRetentionDays,
        staleAssignmentGraceMinutes,
        redactedChatMessages: rowCount(redactedChatMessages),
        redactedRawIrcMessages: rowCount(redactedRawIrcMessages),
        redactedRawEventSubEvents: rowCount(redactedRawEventSubEvents),
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
