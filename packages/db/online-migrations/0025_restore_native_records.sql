-- Offline, lossless rollback of record layouts 0025-0027. Run with the matching application stopped.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF (SELECT max(created_at) FROM drizzle.__drizzle_migrations)<>1791630004000
   OR (SELECT count(*) FROM drizzle.__drizzle_migrations WHERE created_at BETWEEN 1791630001000 AND 1791630004000)<>4 THEN
   RAISE EXCEPTION 'Expected the complete 0024-0028 package with no later migrations';
 END IF;
END $$;
DROP VIEW chat_messages;
DROP VIEW raw_irc_messages;
DROP VIEW stream_snapshots;
DROP TRIGGER chat_record_times ON chat_message_records;
DROP TRIGGER raw_record_times ON raw_irc_records;
DROP TRIGGER snapshot_record_times ON stream_snapshot_records;
ALTER TABLE chat_message_records DROP CONSTRAINT chat_record_times_shape;
ALTER TABLE raw_irc_records DROP CONSTRAINT raw_record_times_shape;
ALTER TABLE stream_snapshot_records DROP CONSTRAINT snapshot_record_times_shape;

ALTER TABLE chat_message_records
 ALTER COLUMN updated_at TYPE timestamptz USING coalesce(updated_at,unpack_record_time(record_times,received_at)),
 ALTER COLUMN record_times TYPE timestamptz USING unpack_record_time(record_times,received_at),
 ALTER COLUMN source DROP DEFAULT, ALTER COLUMN message_type DROP DEFAULT,
 DROP CONSTRAINT chat_source_encoding, DROP CONSTRAINT chat_type_encoding,
 ALTER COLUMN source TYPE text USING decode_common_label(source,'irc'),
 ALTER COLUMN message_type TYPE text USING decode_common_label(message_type,'privmsg'),
 ALTER COLUMN updated_at SET NOT NULL, ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE chat_message_records RENAME COLUMN record_times TO created_at;
ALTER TABLE chat_message_records ALTER COLUMN created_at SET DEFAULT now(),
 ALTER COLUMN source SET DEFAULT 'irc', ALTER COLUMN message_type SET DEFAULT 'privmsg';
ALTER TABLE chat_message_records RENAME TO chat_messages;

ALTER TABLE raw_irc_records
 ALTER COLUMN updated_at TYPE timestamptz USING coalesce(updated_at,unpack_record_time(record_times,received_at)),
 ALTER COLUMN record_times TYPE timestamptz USING unpack_record_time(record_times,received_at),
 ALTER COLUMN updated_at SET NOT NULL, ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE raw_irc_records RENAME COLUMN record_times TO created_at;
ALTER TABLE raw_irc_records ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE raw_irc_records RENAME TO raw_irc_messages;

ALTER TABLE stream_snapshot_records
 ALTER COLUMN updated_at TYPE timestamptz USING coalesce(updated_at,unpack_record_time(record_times,observed_at)),
 ALTER COLUMN record_times TYPE timestamptz USING unpack_record_time(record_times,observed_at),
 ALTER COLUMN tags DROP DEFAULT, DROP CONSTRAINT snapshot_tags_encoding,
 ALTER COLUMN tags TYPE jsonb USING decode_compact_json(tags),
 ALTER COLUMN updated_at SET NOT NULL, ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE stream_snapshot_records RENAME COLUMN record_times TO created_at;
ALTER TABLE stream_snapshot_records ALTER COLUMN created_at SET DEFAULT now(), ALTER COLUMN tags SET DEFAULT '[]'::jsonb;
ALTER TABLE stream_snapshot_records RENAME TO stream_snapshots;

DROP FUNCTION record_times_default();
DROP FUNCTION unpack_record_time(bytea,timestamptz);
DROP FUNCTION pack_record_time(timestamptz,timestamptz);
DELETE FROM drizzle.__drizzle_migrations WHERE created_at BETWEEN 1791630001000 AND 1791630003000;
COMMIT;
