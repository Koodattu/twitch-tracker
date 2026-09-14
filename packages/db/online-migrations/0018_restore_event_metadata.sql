-- Restore the pre-0017 format with API/worker writes stopped and expansion space available.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1789387200000)
    OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at > 1789387200000) THEN
    RAISE EXCEPTION 'Expected migration 0017 as the latest migration';
  END IF;
END
$$;
ALTER TABLE chat_messages
  DROP CONSTRAINT chat_badges_encoding,
  DROP CONSTRAINT chat_emotes_encoding,
  ALTER COLUMN badges DROP DEFAULT,
  ALTER COLUMN emotes DROP DEFAULT;
ALTER TABLE chat_messages
  ALTER COLUMN badges TYPE jsonb USING decode_compact_json(badges),
  ALTER COLUMN emotes TYPE jsonb USING decode_compact_json(emotes),
  ALTER COLUMN badges SET DEFAULT '{}'::jsonb,
  ALTER COLUMN emotes SET DEFAULT '{}'::jsonb;
ALTER TABLE chat_membership_events
  DROP CONSTRAINT membership_source_encoding,
  ALTER COLUMN source DROP DEFAULT;
ALTER TABLE chat_membership_events
  ALTER COLUMN source TYPE text USING decode_common_label(source,'irc_membership'),
  ALTER COLUMN source SET DEFAULT 'irc_membership';
ALTER TABLE raw_irc_messages
  DROP CONSTRAINT raw_irc_tags_encoding,
  DROP CONSTRAINT raw_irc_command_encoding,
  ALTER COLUMN tags DROP DEFAULT;
ALTER TABLE raw_irc_messages
  ALTER COLUMN tags TYPE jsonb USING decode_compact_json(tags),
  ALTER COLUMN parsed_command TYPE text USING decode_common_label(parsed_command,'PRIVMSG'),
  ALTER COLUMN tags SET DEFAULT '{}'::jsonb;
ALTER TABLE raw_irc_messages RESET (autovacuum_vacuum_scale_factor,autovacuum_analyze_scale_factor);
DROP FUNCTION encode_compact_json(jsonb);
DROP FUNCTION decode_compact_json(bytea);
DROP FUNCTION encode_common_label(text,text);
DROP FUNCTION decode_common_label(text,text);
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1789387200000;
COMMIT;
