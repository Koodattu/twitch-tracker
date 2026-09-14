SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE FUNCTION encode_compact_json(value jsonb) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  keys constant text[] := ARRAY['subscriber','premium','bits','moderator','partner','broadcaster','vip','staff','founder','sub-gifter','artist','no_audio','no_video','turbo','admin','global_mod','glhf-pledge','bits-leader','squadsub','clip-champ'];
  item record;
  code integer;
  bytes bytea;
  result bytea := decode('03','hex');
BEGIN
  IF value = '{}'::jsonb THEN RETURN decode('00','hex'); END IF;
  IF jsonb_typeof(value) = 'object' THEN
    IF jsonb_typeof(value->'raw') = 'string' AND value = jsonb_build_object('raw',value->'raw') THEN
      RETURN decode('01','hex') || convert_to(value->>'raw','UTF8');
    END IF;
    FOR item IN SELECT key,val FROM jsonb_each(value) AS e(key,val) ORDER BY array_position(keys,key) LOOP
      code := array_position(keys,item.key);
      IF code IS NULL OR jsonb_typeof(item.val) <> 'string' THEN
        RETURN decode('02','hex') || convert_to(value::text,'UTF8');
      END IF;
      bytes := convert_to(item.val #>> '{}','UTF8');
      IF octet_length(bytes) > 255 THEN RETURN decode('02','hex') || convert_to(value::text,'UTF8'); END IF;
      result := result || set_byte(decode('00','hex'),0,code) || set_byte(decode('00','hex'),0,octet_length(bytes)) || bytes;
    END LOOP;
    RETURN result;
  END IF;
  RETURN decode('02','hex') || convert_to(value::text,'UTF8');
END
$$;
--> statement-breakpoint
CREATE FUNCTION decode_compact_json(value bytea) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  keys constant text[] := ARRAY['subscriber','premium','bits','moderator','partner','broadcaster','vip','staff','founder','sub-gifter','artist','no_audio','no_video','turbo','admin','global_mod','glhf-pledge','bits-leader','squadsub','clip-champ'];
  marker integer;
  offset_bytes integer := 1;
  code integer;
  size integer;
  result jsonb := '{}'::jsonb;
BEGIN
  IF octet_length(value) = 0 THEN RAISE EXCEPTION 'Invalid compact JSON encoding'; END IF;
  marker := get_byte(value,0);
  IF marker = 0 AND octet_length(value) = 1 THEN RETURN result; END IF;
  IF marker = 1 THEN RETURN jsonb_build_object('raw',convert_from(substring(value FROM 2),'UTF8')); END IF;
  IF marker = 2 THEN RETURN convert_from(substring(value FROM 2),'UTF8')::jsonb; END IF;
  IF marker = 3 AND octet_length(value) > 1 THEN
    WHILE offset_bytes < octet_length(value) LOOP
      IF offset_bytes + 2 > octet_length(value) THEN RAISE EXCEPTION 'Invalid compact JSON map'; END IF;
      code := get_byte(value,offset_bytes);
      size := get_byte(value,offset_bytes+1);
      IF code < 1 OR code > cardinality(keys) OR offset_bytes+2+size > octet_length(value) OR result ? keys[code] THEN
        RAISE EXCEPTION 'Invalid compact JSON map';
      END IF;
      result := result || jsonb_build_object(keys[code],convert_from(substring(value FROM offset_bytes+3 FOR size),'UTF8'));
      offset_bytes := offset_bytes+2+size;
    END LOOP;
    RETURN result;
  END IF;
  RAISE EXCEPTION 'Invalid compact JSON encoding';
END
$$;
--> statement-breakpoint
CREATE FUNCTION encode_common_label(value text, common text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT CASE WHEN value = common THEN '' ELSE '!' || value END $$;
--> statement-breakpoint
CREATE FUNCTION decode_common_label(value text, common text) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  IF value = '' THEN RETURN common; END IF;
  IF left(value,1) = '!' THEN RETURN substring(value FROM 2); END IF;
  RAISE EXCEPTION 'Invalid compact label encoding';
END
$$;
--> statement-breakpoint
ALTER TABLE chat_messages ALTER COLUMN badges DROP DEFAULT, ALTER COLUMN emotes DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE chat_messages
  ALTER COLUMN badges TYPE bytea USING encode_compact_json(badges),
  ALTER COLUMN emotes TYPE bytea USING encode_compact_json(emotes),
  ALTER COLUMN badges SET DEFAULT decode('00','hex'),
  ALTER COLUMN emotes SET DEFAULT decode('00','hex'),
  ADD CONSTRAINT chat_badges_encoding CHECK (decode_compact_json(badges) IS NOT NULL),
  ADD CONSTRAINT chat_emotes_encoding CHECK (decode_compact_json(emotes) IS NOT NULL);
--> statement-breakpoint
ALTER TABLE chat_membership_events ALTER COLUMN source DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE chat_membership_events
  ALTER COLUMN source TYPE text USING encode_common_label(source,'irc_membership'),
  ALTER COLUMN source SET DEFAULT '',
  ADD CONSTRAINT membership_source_encoding CHECK (source = '' OR left(source,1) = '!');
--> statement-breakpoint
ALTER TABLE raw_irc_messages ALTER COLUMN tags DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE raw_irc_messages
  ALTER COLUMN tags TYPE bytea USING encode_compact_json(tags),
  ALTER COLUMN parsed_command TYPE text USING encode_common_label(parsed_command,'PRIVMSG'),
  ALTER COLUMN tags SET DEFAULT decode('00','hex'),
  ADD CONSTRAINT raw_irc_tags_encoding CHECK (decode_compact_json(tags) IS NOT NULL),
  ADD CONSTRAINT raw_irc_command_encoding CHECK (parsed_command IS NULL OR parsed_command = '' OR left(parsed_command,1) = '!');
--> statement-breakpoint
ALTER TABLE raw_irc_messages SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
