SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- These summaries have no application reader. Their activity metrics are derived
-- from retained chat/membership events; never silently discard independent metadata.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM chatter_channel_activity_buckets
   WHERE emote_counts <> '{}'::jsonb OR badge_observations <> '{}'::jsonb) THEN
   RAISE EXCEPTION 'Cannot retire chatter rollups with independent emote/badge metadata';
 END IF;
END $$;
--> statement-breakpoint
DROP TABLE chatter_channel_activity_buckets;
