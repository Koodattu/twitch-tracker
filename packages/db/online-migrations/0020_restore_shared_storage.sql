-- Restore the pre-0018 layout with API/worker writes stopped and expansion space available.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1789489900000)
    OR EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at > 1789489900000) THEN
    RAISE EXCEPTION 'Expected migration 0019 as the latest migration';
  END IF;
END $$;
ALTER TABLE raw_irc_messages
  ADD COLUMN channel_login text,
  ADD COLUMN bot_account_id uuid,
  ADD COLUMN irc_connection_id uuid;
UPDATE raw_irc_messages r SET channel_login=c.channel_login,bot_account_id=c.bot_account_id,irc_connection_id=c.irc_connection_id
FROM raw_irc_contexts c WHERE c.id=r.context_id;
ALTER TABLE raw_irc_messages DROP COLUMN context_id,
  ADD CONSTRAINT raw_irc_messages_bot_account_id_bot_accounts_id_fk FOREIGN KEY (bot_account_id) REFERENCES bot_accounts(id),
  ADD CONSTRAINT raw_irc_messages_irc_connection_id_irc_connections_id_fk FOREIGN KEY (irc_connection_id) REFERENCES irc_connections(id);
DROP FUNCTION get_raw_irc_context(text,uuid,uuid);
DROP TABLE raw_irc_contexts;
DROP FUNCTION protect_raw_irc_context();
DROP TRIGGER membership_key_guard ON chat_membership_events;
DROP FUNCTION preserve_membership_key();
DROP INDEX chat_membership_events_dedupe_key_idx;
ALTER TABLE chat_membership_events DROP CONSTRAINT membership_digest_length;
UPDATE chat_membership_events SET dedupe_key_storage=read_membership_key(
  broadcaster_user_id,twitch_stream_id,event_type,chatter_login,event_at,dedupe_key_storage
) WHERE octet_length(dedupe_key_storage)=0;
ALTER TABLE chat_membership_events RENAME COLUMN dedupe_key_storage TO dedupe_key;
ALTER TABLE chat_membership_events ADD CONSTRAINT membership_digest_length CHECK (dedupe_key IS NULL OR octet_length(dedupe_key)=32);
CREATE UNIQUE INDEX chat_membership_events_dedupe_key_idx ON chat_membership_events(dedupe_key);
DROP INDEX chat_membership_events_time_brin;
DROP INDEX chat_messages_event_time_brin;
DROP FUNCTION read_membership_key(text,text,chat_membership_event_type,text,timestamptz,bytea);
DROP FUNCTION derive_membership_key(text,text,chat_membership_event_type,text,timestamptz);
DELETE FROM drizzle.__drizzle_migrations WHERE created_at IN (1789489800000,1789489900000);
COMMIT;
