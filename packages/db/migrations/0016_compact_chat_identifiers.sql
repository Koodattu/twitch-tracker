-- Requires a maintenance window: these type changes rewrite tables and indexes.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE FUNCTION encode_chat_message_id(value text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN decode('00' || replace(value, '-', ''), 'hex')
    ELSE decode('01', 'hex') || convert_to(value, 'UTF8') END
$$;
--> statement-breakpoint
CREATE FUNCTION decode_chat_message_id(value bytea) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
BEGIN
  IF get_byte(value, 0) = 1 THEN RETURN convert_from(substring(value from 2), 'UTF8'); END IF;
  IF get_byte(value, 0) = 0 AND octet_length(value) = 17 THEN
    RETURN encode(substring(value from 2), 'hex')::uuid::text;
  END IF;
  RAISE EXCEPTION 'Invalid compact message identifier';
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM chat_membership_events WHERE dedupe_key IS NOT NULL AND (
    length(dedupe_key) <> 43 OR dedupe_key !~ '^[A-Za-z0-9_-]+$'
  )) THEN
    RAISE EXCEPTION 'Membership keys are not canonical SHA-256 digests';
  END IF;
  IF EXISTS (SELECT 1 FROM chat_membership_events WHERE dedupe_key IS NOT NULL
    AND translate(rtrim(encode(decode(translate(dedupe_key, '-_', '+/') || '=', 'base64'), 'base64'), '='), '+/', '-_') <> dedupe_key) THEN
    RAISE EXCEPTION 'Membership digest conversion would change its encoding';
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE chat_messages
  ALTER COLUMN twitch_message_id TYPE bytea USING encode_chat_message_id(twitch_message_id::text),
  ALTER COLUMN reply_parent_message_id TYPE bytea USING encode_chat_message_id(reply_parent_message_id::text),
  ADD CONSTRAINT chat_message_id_encoding CHECK (encode_chat_message_id(decode_chat_message_id(twitch_message_id)) = twitch_message_id),
  ADD CONSTRAINT chat_reply_id_encoding CHECK (reply_parent_message_id IS NULL OR encode_chat_message_id(decode_chat_message_id(reply_parent_message_id)) = reply_parent_message_id);
--> statement-breakpoint
ALTER TABLE chat_membership_events
  ALTER COLUMN dedupe_key TYPE bytea USING decode(translate(dedupe_key, '-_', '+/') || '=', 'base64'),
  ADD CONSTRAINT membership_digest_length CHECK (dedupe_key IS NULL OR octet_length(dedupe_key) = 32);
