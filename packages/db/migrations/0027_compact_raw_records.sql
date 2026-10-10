SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- A type rewrite copies live rows and rebuilds indexes atomically, without an
-- UPDATE/backfill leaving a second heap of dead tuples. The view has no write
-- triggers: inserts and ordinary updates are rewritten to the physical table.
ALTER TABLE raw_irc_messages
 ALTER COLUMN created_at DROP DEFAULT,
 ALTER COLUMN created_at TYPE bytea USING pack_record_time(received_at,created_at),
 ALTER COLUMN updated_at DROP DEFAULT, ALTER COLUMN updated_at DROP NOT NULL,
 ALTER COLUMN updated_at TYPE timestamptz USING nullif(updated_at,created_at);
--> statement-breakpoint
ALTER TABLE raw_irc_messages RENAME COLUMN created_at TO record_times;
--> statement-breakpoint
ALTER TABLE raw_irc_messages RENAME TO raw_irc_records;
--> statement-breakpoint
ALTER TABLE raw_irc_records ADD CONSTRAINT raw_record_times_shape CHECK (
 CASE WHEN octet_length(record_times)=0 THEN false ELSE get_byte(record_times,0)<=2
 AND octet_length(record_times)=1+4*get_byte(record_times,0) END);
--> statement-breakpoint
CREATE TRIGGER raw_record_times BEFORE INSERT OR UPDATE OF received_at ON raw_irc_records
 FOR EACH ROW EXECUTE FUNCTION record_times_default('received_at');
--> statement-breakpoint
CREATE VIEW raw_irc_messages AS SELECT id,raw_line,parsed_command,tags,received_at,processing_status,parse_error,
 unpack_record_time(record_times,received_at) AS created_at,
 coalesce(updated_at,unpack_record_time(record_times,received_at)) AS updated_at,
 payload_block_id,payload_position,unrelayed_source,context_id FROM raw_irc_records;
--> statement-breakpoint
ANALYZE raw_irc_records;
