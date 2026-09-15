SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE FUNCTION derive_membership_key(channel_id text, stream_id text, kind chat_membership_event_type, login text, occurred_at timestamptz)
RETURNS bytea LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN channel_id IS NOT NULL AND occurred_at IS NOT NULL
    AND extract(year FROM occurred_at AT TIME ZONE 'UTC') BETWEEN 1 AND 9999
    AND kind IN ('join', 'part') THEN
    sha256(convert_to('irc_membership:' || channel_id || ':' || coalesce(stream_id, 'no-stream') || ':' ||
      CASE kind WHEN 'join' THEN 'join' WHEN 'part' THEN 'part' END || ':' || coalesce(login, 'unknown') || ':' ||
      to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"'), 'UTF8'))
    ELSE NULL END
$$;
--> statement-breakpoint
CREATE FUNCTION read_membership_key(channel_id text, stream_id text, kind chat_membership_event_type, login text, occurred_at timestamptz, stored_key bytea)
RETURNS bytea LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN stored_key = decode('', 'hex')
    THEN public.derive_membership_key(channel_id, stream_id, kind, login, occurred_at)
    ELSE stored_key END
$$;
--> statement-breakpoint
ALTER TABLE chat_membership_events RENAME COLUMN dedupe_key TO dedupe_key_storage;
--> statement-breakpoint
ALTER TABLE chat_membership_events DROP CONSTRAINT membership_digest_length;
--> statement-breakpoint
DROP INDEX chat_membership_events_dedupe_key_idx;
--> statement-breakpoint
UPDATE chat_membership_events SET dedupe_key_storage = decode('', 'hex')
WHERE dedupe_key_storage = derive_membership_key(broadcaster_user_id, twitch_stream_id, event_type, chatter_login, event_at);
--> statement-breakpoint
ALTER TABLE chat_membership_events ADD CONSTRAINT membership_digest_length CHECK (
  dedupe_key_storage IS NULL OR octet_length(dedupe_key_storage) = 32 OR
  (octet_length(dedupe_key_storage) = 0 AND derive_membership_key(broadcaster_user_id, twitch_stream_id, event_type, chatter_login, event_at) IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX chat_membership_events_dedupe_key_idx ON chat_membership_events (
  read_membership_key(broadcaster_user_id, twitch_stream_id, event_type, chatter_login, event_at, dedupe_key_storage)
);
--> statement-breakpoint
CREATE FUNCTION preserve_membership_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.dedupe_key_storage = decode('', 'hex')
    AND NEW.dedupe_key_storage IS NOT DISTINCT FROM OLD.dedupe_key_storage
    AND (NEW.broadcaster_user_id, NEW.twitch_stream_id, NEW.event_type, NEW.chatter_login, NEW.event_at)
      IS DISTINCT FROM (OLD.broadcaster_user_id, OLD.twitch_stream_id, OLD.event_type, OLD.chatter_login, OLD.event_at) THEN
    -- Identity repair and privacy redaction must not change the original dedupe key.
    NEW.dedupe_key_storage := public.derive_membership_key(OLD.broadcaster_user_id, OLD.twitch_stream_id, OLD.event_type, OLD.chatter_login, OLD.event_at);
  END IF;
  IF NEW.dedupe_key_storage = public.derive_membership_key(NEW.broadcaster_user_id, NEW.twitch_stream_id, NEW.event_type, NEW.chatter_login, NEW.event_at) THEN
    NEW.dedupe_key_storage := decode('', 'hex');
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER membership_key_guard BEFORE INSERT OR UPDATE ON chat_membership_events
FOR EACH ROW EXECUTE FUNCTION preserve_membership_key();
--> statement-breakpoint
CREATE INDEX chat_membership_events_time_brin ON chat_membership_events USING brin
  (received_at, (coalesce(event_at, received_at))) WITH (pages_per_range = 32, autosummarize = on);
--> statement-breakpoint
CREATE INDEX chat_messages_event_time_brin ON chat_messages USING brin
  ((coalesce(sent_at, received_at))) WITH (pages_per_range = 32, autosummarize = on);
