SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$ DECLARE constraint_row record;
BEGIN
 FOR constraint_row IN SELECT conrelid::regclass AS relation,conname FROM pg_constraint
   WHERE contype='f' AND conrelid IN('stream_snapshots'::regclass)
   AND confrelid IN('twitch_users'::regclass,'stream_sessions'::regclass)
 LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',constraint_row.relation,constraint_row.conname); END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE stream_snapshots
 ALTER COLUMN broadcaster_user_id TYPE bytea USING encode_external_key(broadcaster_user_id),
 ALTER COLUMN twitch_stream_id TYPE bytea USING encode_external_key(twitch_stream_id),
 ADD FOREIGN KEY(broadcaster_user_id) REFERENCES twitch_users(storage_key),
 ADD FOREIGN KEY(twitch_stream_id) REFERENCES stream_sessions(storage_key),
ALTER COLUMN tags DROP DEFAULT,
 ALTER COLUMN tags TYPE bytea USING encode_compact_json(tags),
 ALTER COLUMN created_at DROP DEFAULT,
 ALTER COLUMN created_at TYPE bytea USING pack_record_time(observed_at,created_at),
 ALTER COLUMN updated_at DROP DEFAULT, ALTER COLUMN updated_at DROP NOT NULL,
 ALTER COLUMN updated_at TYPE timestamptz USING nullif(updated_at,created_at);
--> statement-breakpoint
ALTER TABLE stream_snapshots ALTER COLUMN tags SET DEFAULT encode_compact_json('[]'::jsonb),
 ADD CONSTRAINT snapshot_tags_encoding CHECK(decode_compact_json(tags) IS NOT NULL);
--> statement-breakpoint
ALTER TABLE stream_snapshots RENAME COLUMN created_at TO record_times;
--> statement-breakpoint
ALTER TABLE stream_snapshots RENAME TO stream_snapshot_records;
--> statement-breakpoint
ALTER TABLE stream_snapshot_records ADD CONSTRAINT snapshot_record_times_shape CHECK (
 CASE WHEN octet_length(record_times)=0 THEN false ELSE get_byte(record_times,0)<=2
 AND octet_length(record_times)=1+4*get_byte(record_times,0) END);
--> statement-breakpoint
CREATE TRIGGER snapshot_record_times BEFORE INSERT OR UPDATE OF observed_at ON stream_snapshot_records
 FOR EACH ROW EXECUTE FUNCTION record_times_default('observed_at');
--> statement-breakpoint
CREATE VIEW stream_snapshots AS SELECT id,twitch_stream_id,broadcaster_user_id,observed_at,viewer_count,title,category_id,
 category_name,language,tags,thumbnail_url,source_run_id,
 unpack_record_time(record_times,observed_at) AS created_at,
 coalesce(updated_at,unpack_record_time(record_times,observed_at)) AS updated_at FROM stream_snapshot_records;
--> statement-breakpoint
ANALYZE stream_snapshot_records;
