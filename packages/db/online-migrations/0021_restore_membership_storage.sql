-- Run with writers stopped. Preserve room for the expanded table and indexes.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at=1789646400000)
 OR EXISTS(SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at>1789646400000) THEN
   RAISE EXCEPTION 'Expected migration 0020 as the latest migration';
 END IF;
END $$;
CREATE TABLE membership_restored AS SELECT * FROM chat_membership_events;
DROP FUNCTION insert_membership_event(text,text,text,text,chat_membership_event_type,timestamptz,timestamptz,bytea,uuid);
DROP VIEW chat_membership_events;
DROP FUNCTION write_membership_event();
DROP TABLE membership_event_rows;
ALTER TABLE membership_restored RENAME TO chat_membership_events;
ALTER TABLE chat_membership_events
 ADD CONSTRAINT chat_membership_events_pkey PRIMARY KEY(id),
 ALTER COLUMN id SET DEFAULT gen_random_uuid(),
 ALTER COLUMN broadcaster_user_id SET NOT NULL,
 ALTER COLUMN event_type SET NOT NULL,
 ALTER COLUMN source SET NOT NULL, ALTER COLUMN source SET DEFAULT '',
 ALTER COLUMN confidence SET NOT NULL, ALTER COLUMN confidence SET DEFAULT 70,
 ALTER COLUMN received_at SET NOT NULL, ALTER COLUMN received_at SET DEFAULT now(),
 ALTER COLUMN created_at SET NOT NULL, ALTER COLUMN created_at SET DEFAULT now(),
 ALTER COLUMN updated_at SET NOT NULL, ALTER COLUMN updated_at SET DEFAULT now(),
 ADD FOREIGN KEY(broadcaster_user_id) REFERENCES twitch_users(twitch_user_id),
 ADD FOREIGN KEY(chatter_user_id) REFERENCES twitch_users(twitch_user_id),
 ADD FOREIGN KEY(twitch_stream_id) REFERENCES stream_sessions(twitch_stream_id),
 ADD FOREIGN KEY(raw_irc_message_id) REFERENCES raw_irc_messages(id),
 ADD FOREIGN KEY(irc_connection_id) REFERENCES irc_connections(id),
 ADD CONSTRAINT membership_source_encoding CHECK(source='' OR left(source,1)='!'),
 ADD CONSTRAINT membership_digest_length CHECK(dedupe_key_storage IS NULL OR octet_length(dedupe_key_storage)=32 OR
 (octet_length(dedupe_key_storage)=0 AND derive_membership_key(broadcaster_user_id,twitch_stream_id,event_type,chatter_login,event_at) IS NOT NULL));
CREATE INDEX chat_membership_events_chatter_received_idx ON chat_membership_events(chatter_user_id,received_at);
CREATE INDEX chat_membership_events_unresolved_idx ON chat_membership_events(received_at)
 WHERE chatter_user_id IS NULL AND identity_checked_at IS NULL AND chatter_login IS NOT NULL;
CREATE UNIQUE INDEX chat_membership_events_dedupe_key_idx ON chat_membership_events
 (read_membership_key(broadcaster_user_id,twitch_stream_id,event_type,chatter_login,event_at,dedupe_key_storage));
CREATE INDEX chat_membership_events_time_brin ON chat_membership_events USING brin(received_at,(coalesce(event_at,received_at)))
 WITH(pages_per_range=32,autosummarize=on);
CREATE TRIGGER membership_key_guard BEFORE INSERT OR UPDATE ON chat_membership_events FOR EACH ROW EXECUTE FUNCTION preserve_membership_key();
DELETE FROM drizzle.__drizzle_migrations WHERE created_at=1789646400000;
ANALYZE chat_membership_events;
COMMIT;
