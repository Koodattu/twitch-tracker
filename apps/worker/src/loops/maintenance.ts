import { sql } from "drizzle-orm";
import type { WorkerContext } from "../worker.js";
import { startIntervalLoop } from "./common.js";

export const runMaintenanceLoop = (context: WorkerContext) => {
  startIntervalLoop({
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

      const closedStaleAssignments = await context.db.execute(sql`
        with closed as (
          update chat_assignments ca
          set status = 'left',
              left_at = coalesce(ca.left_at, now()),
              latest_error = null,
              updated_at = now()
          from stream_sessions ss
          where ca.twitch_stream_id = ss.twitch_stream_id
            and ca.status in ('desired', 'joining', 'joined', 'leaving')
            and ss.ended_at is not null
            and ss.ended_at < now() - (${staleAssignmentGraceMinutes} * interval '1 minute')
          returning ca.id, ss.twitch_stream_id
        )
        insert into chat_assignment_events (
          chat_assignment_id,
          event_type,
          reason,
          details,
          occurred_at,
          created_at,
          updated_at
        )
        select
          id,
          'left',
          'stream ended maintenance cleanup',
          jsonb_build_object('source', 'maintenance', 'twitchStreamId', twitch_stream_id),
          now(),
          now(),
          now()
        from closed
      `);

      return {
        rawChatRetentionDays,
        rawPayloadRetentionDays,
        staleAssignmentGraceMinutes,
        redactedChatMessages: rowCount(redactedChatMessages),
        redactedRawIrcMessages: rowCount(redactedRawIrcMessages),
        redactedRawEventSubEvents: rowCount(redactedRawEventSubEvents),
        redactedRawHelixResponses: rowCount(redactedRawHelixResponses),
        closedStaleAssignments: rowCount(closedStaleAssignments)
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
