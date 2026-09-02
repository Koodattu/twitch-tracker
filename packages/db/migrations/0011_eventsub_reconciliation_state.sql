ALTER TABLE "raw_eventsub_events" ADD COLUMN "message_type" text;--> statement-breakpoint
ALTER TABLE "eventsub_subscriptions" ADD COLUMN "is_desired" boolean DEFAULT false NOT NULL;--> statement-breakpoint
WITH "ordered_raids" AS (
  SELECT
    "id",
    "raw_eventsub_event_id",
    "occurred_at",
    lag("occurred_at") OVER (
      PARTITION BY "source_broadcaster_user_id", "target_broadcaster_user_id"
      ORDER BY "occurred_at", "id"
    ) AS "previous_occurred_at"
  FROM "raids"
),
"duplicate_raids" AS (
  SELECT "id", "raw_eventsub_event_id"
  FROM "ordered_raids"
  WHERE "occurred_at" - "previous_occurred_at" BETWEEN interval '0 seconds' AND interval '60 seconds'
)
DELETE FROM "channel_events"
WHERE "raw_eventsub_event_id" IN (
  SELECT "raw_eventsub_event_id"
  FROM "duplicate_raids"
  WHERE "raw_eventsub_event_id" IS NOT NULL
);--> statement-breakpoint
WITH "ordered_raids" AS (
  SELECT
    "id",
    "occurred_at",
    lag("occurred_at") OVER (
      PARTITION BY "source_broadcaster_user_id", "target_broadcaster_user_id"
      ORDER BY "occurred_at", "id"
    ) AS "previous_occurred_at"
  FROM "raids"
),
"duplicate_raids" AS (
  SELECT "id"
  FROM "ordered_raids"
  WHERE "occurred_at" - "previous_occurred_at" BETWEEN interval '0 seconds' AND interval '60 seconds'
)
DELETE FROM "raids"
WHERE "id" IN (SELECT "id" FROM "duplicate_raids");
