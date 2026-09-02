DROP INDEX CONCURRENTLY IF EXISTS "raw_irc_messages_channel_received_idx";
DROP INDEX CONCURRENTLY IF EXISTS "chat_membership_events_channel_received_idx";
DROP INDEX CONCURRENTLY IF EXISTS "eventsub_subscriptions_status_idx";
DROP INDEX CONCURRENTLY IF EXISTS "channel_events_source_event_idx";
DROP INDEX CONCURRENTLY IF EXISTS "channel_events_channel_occurred_idx";

SELECT index_name, to_regclass(format('public.%I', index_name)) IS NULL AS removed
FROM unnest(ARRAY[
  'raw_irc_messages_channel_received_idx',
  'chat_membership_events_channel_received_idx',
  'eventsub_subscriptions_status_idx',
  'channel_events_source_event_idx',
  'channel_events_channel_occurred_idx'
]) AS indexes(index_name)
ORDER BY index_name;
