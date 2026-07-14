CREATE INDEX CONCURRENTLY IF NOT EXISTS "twitch_users_login_idx" ON "twitch_users" USING btree ("login");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "stream_sessions_broadcaster_started_idx" ON "stream_sessions" USING btree ("broadcaster_user_id","started_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "stream_sessions_live_language_idx" ON "stream_sessions" USING btree ("language","last_seen_live_at") WHERE "ended_at" is null;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "stream_sessions_recent_ended_idx" ON "stream_sessions" USING btree ("language","ended_at") WHERE "ended_at" is not null;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_assignments_stream_status_idx" ON "chat_assignments" USING btree ("twitch_stream_id","status");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "channel_events_stream_occurred_idx" ON "channel_events" USING btree ("twitch_stream_id","occurred_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "raids_source_stream_occurred_idx" ON "raids" USING btree ("source_stream_id","occurred_at");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "raids_target_stream_occurred_idx" ON "raids" USING btree ("target_stream_id","occurred_at");

SELECT index_class.relname AS index_name, index_state.indisready, index_state.indisvalid
FROM pg_index AS index_state
INNER JOIN pg_class AS index_class ON index_class.oid = index_state.indexrelid
WHERE index_class.relname IN (
  'twitch_users_login_idx',
  'stream_sessions_broadcaster_started_idx',
  'stream_sessions_live_language_idx',
  'stream_sessions_recent_ended_idx',
  'chat_assignments_stream_status_idx',
  'channel_events_stream_occurred_idx',
  'raids_source_stream_occurred_idx',
  'raids_target_stream_occurred_idx'
)
ORDER BY index_class.relname;
