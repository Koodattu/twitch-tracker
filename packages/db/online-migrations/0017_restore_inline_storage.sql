-- Roll back 0015/0016 only with API and worker writes stopped and sufficient
-- free space for expanded rows, replacement indexes and WAL. Keep a fresh backup.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at > 1789135300000) THEN
    RAISE EXCEPTION 'Newer migrations exist; this rollback must be reviewed for the current schema';
  END IF;
END
$$;

UPDATE raw_irc_messages
SET raw_line = read_raw_irc_line(raw_line, payload_block_id, payload_position)
WHERE payload_block_id IS NOT NULL;

ALTER TABLE chat_messages
  DROP CONSTRAINT chat_message_id_encoding,
  DROP CONSTRAINT chat_reply_id_encoding,
  ALTER COLUMN twitch_message_id TYPE text USING decode_chat_message_id(twitch_message_id),
  ALTER COLUMN reply_parent_message_id TYPE text USING decode_chat_message_id(reply_parent_message_id);
ALTER TABLE chat_membership_events
  DROP CONSTRAINT membership_digest_length,
  ALTER COLUMN dedupe_key TYPE text USING translate(rtrim(encode(dedupe_key, 'base64'), '='), '+/', '-_');

DROP TRIGGER raw_irc_payload_guard ON raw_irc_messages;
DROP TRIGGER raw_irc_locator_guard ON raw_irc_messages;
DROP FUNCTION compact_raw_irc_batch(timestamptz, integer);
DROP FUNCTION protect_raw_irc_payload();
DROP FUNCTION read_raw_irc_line(text, bigint, smallint);
DROP FUNCTION encode_chat_message_id(text);
DROP FUNCTION decode_chat_message_id(bytea);
DROP INDEX raw_irc_messages_unpacked_idx;
ALTER TABLE raw_irc_messages
  DROP CONSTRAINT raw_irc_payload_location,
  DROP COLUMN payload_block_id,
  DROP COLUMN payload_position,
  DROP COLUMN unrelayed_source;
DROP TABLE raw_irc_payload_blocks;
DELETE FROM drizzle.__drizzle_migrations WHERE created_at IN (1789135200000, 1789135300000);
COMMIT;
