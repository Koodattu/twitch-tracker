SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$ DECLARE constraint_row record;
BEGIN
 FOR constraint_row IN SELECT conrelid::regclass AS relation,conname FROM pg_constraint
   WHERE contype='f' AND conrelid IN('chat_messages'::regclass)
   AND confrelid IN('twitch_users'::regclass,'stream_sessions'::regclass)
 LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',constraint_row.relation,constraint_row.conname); END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE chat_messages
 ALTER COLUMN broadcaster_user_id TYPE bytea USING encode_external_key(broadcaster_user_id),
 ALTER COLUMN twitch_stream_id TYPE bytea USING encode_external_key(twitch_stream_id),
 ALTER COLUMN chatter_user_id TYPE bytea USING encode_external_key(chatter_user_id),
 ALTER COLUMN shared_chat_source_channel_id TYPE bytea USING encode_external_key(shared_chat_source_channel_id),
 ADD FOREIGN KEY(broadcaster_user_id) REFERENCES twitch_users(storage_key),
 ADD FOREIGN KEY(chatter_user_id) REFERENCES twitch_users(storage_key),
 ADD FOREIGN KEY(twitch_stream_id) REFERENCES stream_sessions(storage_key),
 ADD CONSTRAINT chat_shared_channel_encoding CHECK(shared_chat_source_channel_id IS NULL OR decode_external_key(shared_chat_source_channel_id) IS NOT NULL),
ALTER COLUMN source DROP DEFAULT, ALTER COLUMN message_type DROP DEFAULT,
 ALTER COLUMN source TYPE text USING encode_common_label(source,'irc'),
 ALTER COLUMN message_type TYPE text USING encode_common_label(message_type,'privmsg'),
 ALTER COLUMN created_at DROP DEFAULT,
 ALTER COLUMN created_at TYPE bytea USING pack_record_time(received_at,created_at),
 ALTER COLUMN updated_at DROP DEFAULT, ALTER COLUMN updated_at DROP NOT NULL,
 ALTER COLUMN updated_at TYPE timestamptz USING nullif(updated_at,created_at);
--> statement-breakpoint
ALTER TABLE chat_messages ALTER COLUMN source SET DEFAULT '', ALTER COLUMN message_type SET DEFAULT '',
 ADD CONSTRAINT chat_source_encoding CHECK(source='' OR left(source,1)='!'),
 ADD CONSTRAINT chat_type_encoding CHECK(message_type='' OR left(message_type,1)='!');
--> statement-breakpoint
ALTER TABLE chat_messages RENAME COLUMN created_at TO record_times;
--> statement-breakpoint
ALTER TABLE chat_messages RENAME TO chat_message_records;
--> statement-breakpoint
ALTER TABLE chat_message_records ADD CONSTRAINT chat_record_times_shape CHECK (
 CASE WHEN octet_length(record_times)=0 THEN false ELSE get_byte(record_times,0)<=2
 AND octet_length(record_times)=1+4*get_byte(record_times,0) END);
--> statement-breakpoint
CREATE TRIGGER chat_record_times BEFORE INSERT OR UPDATE OF received_at ON chat_message_records
 FOR EACH ROW EXECUTE FUNCTION record_times_default('received_at');
--> statement-breakpoint
CREATE VIEW chat_messages AS SELECT twitch_message_id,broadcaster_user_id,twitch_stream_id,chatter_user_id,chatter_login,
 source,sent_at,received_at,message_type,raw_text,badges,emotes,reply_parent_message_id,shared_chat_source_channel_id,
 deleted_at,cleared_at,raw_irc_message_id,raw_eventsub_event_id,
 unpack_record_time(record_times,received_at) AS created_at,
 coalesce(updated_at,unpack_record_time(record_times,received_at)) AS updated_at FROM chat_message_records;
--> statement-breakpoint
ANALYZE chat_message_records;
