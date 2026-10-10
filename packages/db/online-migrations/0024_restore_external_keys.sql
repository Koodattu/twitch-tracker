-- Run after 0025_restore_native_records.sql, with the matching application stopped.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF (SELECT max(created_at) FROM drizzle.__drizzle_migrations)<>1791630004000
   OR EXISTS(SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at BETWEEN 1791630001000 AND 1791630003000) THEN
   RAISE EXCEPTION 'Restore native records first; later migrations must be rolled back separately';
 END IF;
END $$;
DO $$ DECLARE r record;
BEGIN
 FOR r IN SELECT conrelid::regclass AS relation,conname FROM pg_constraint
   WHERE contype='f' AND conrelid IN('chat_messages'::regclass,'stream_snapshots'::regclass,'stream_activity_buckets'::regclass)
   AND confrelid IN('twitch_users'::regclass,'stream_sessions'::regclass)
 LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.relation,r.conname); END LOOP;
END $$;
ALTER TABLE chat_messages DROP CONSTRAINT chat_shared_channel_encoding,
 ALTER COLUMN broadcaster_user_id TYPE text USING decode_external_key(broadcaster_user_id),
 ALTER COLUMN twitch_stream_id TYPE text USING decode_external_key(twitch_stream_id),
 ALTER COLUMN chatter_user_id TYPE text USING decode_external_key(chatter_user_id),
 ALTER COLUMN shared_chat_source_channel_id TYPE text USING decode_external_key(shared_chat_source_channel_id),
 ADD FOREIGN KEY(broadcaster_user_id) REFERENCES twitch_users(twitch_user_id),
 ADD FOREIGN KEY(chatter_user_id) REFERENCES twitch_users(twitch_user_id),
 ADD FOREIGN KEY(twitch_stream_id) REFERENCES stream_sessions(twitch_stream_id);
ALTER TABLE stream_snapshots
 ALTER COLUMN broadcaster_user_id TYPE text USING decode_external_key(broadcaster_user_id),
 ALTER COLUMN twitch_stream_id TYPE text USING decode_external_key(twitch_stream_id),
 ADD FOREIGN KEY(broadcaster_user_id) REFERENCES twitch_users(twitch_user_id),
 ADD FOREIGN KEY(twitch_stream_id) REFERENCES stream_sessions(twitch_stream_id);
ALTER TABLE stream_activity_buckets
 ALTER COLUMN twitch_stream_id TYPE text USING decode_external_key(twitch_stream_id),
 ADD FOREIGN KEY(twitch_stream_id) REFERENCES stream_sessions(twitch_stream_id);
ALTER TABLE twitch_users DROP COLUMN storage_key;
ALTER TABLE stream_sessions DROP COLUMN storage_key;
DROP FUNCTION decode_external_key(bytea);
DROP FUNCTION encode_external_key(text);
DELETE FROM drizzle.__drizzle_migrations WHERE created_at IN (1791630000000,1791630004000);
COMMIT;
