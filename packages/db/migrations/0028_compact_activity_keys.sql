SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$ DECLARE constraint_row record;
BEGIN
 FOR constraint_row IN SELECT conrelid::regclass AS relation,conname FROM pg_constraint
   WHERE contype='f' AND conrelid IN('stream_activity_buckets'::regclass)
   AND confrelid IN('twitch_users'::regclass,'stream_sessions'::regclass)
 LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',constraint_row.relation,constraint_row.conname); END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE stream_activity_buckets
 ALTER COLUMN twitch_stream_id TYPE bytea USING encode_external_key(twitch_stream_id),
 ADD FOREIGN KEY(twitch_stream_id) REFERENCES stream_sessions(storage_key);
--> statement-breakpoint
ANALYZE stream_activity_buckets;
