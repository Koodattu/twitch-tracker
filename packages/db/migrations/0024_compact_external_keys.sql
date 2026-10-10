SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE FUNCTION encode_external_key(value text) RETURNS bytea LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT CASE WHEN value ~ '^(0|[1-9][0-9]{0,14})$' THEN
   CASE WHEN value::bigint <= 4294967295 THEN decode('00','hex') || substring(int8send(value::bigint) FROM 5)
        WHEN value::bigint <= 281474976710655 THEN decode('01','hex') || substring(int8send(value::bigint) FROM 3)
        ELSE decode('02','hex') || convert_to(value,'UTF8') END
   ELSE decode('02','hex') || convert_to(value,'UTF8') END
$$;
--> statement-breakpoint
CREATE FUNCTION decode_external_key(value bytea) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE result text;
BEGIN
 IF (octet_length(value)=5 AND get_byte(value,0)=0) OR (octet_length(value)=7 AND get_byte(value,0)=1) THEN
   result:=(('x'||lpad(encode(substring(value FROM 2),'hex'),16,'0'))::bit(64)::bigint)::text;
 ELSIF octet_length(value)>0 AND get_byte(value,0)=2 THEN
   result:=convert_from(substring(value FROM 2),'UTF8');
 ELSE RAISE EXCEPTION 'Invalid compact external identifier'; END IF;
 IF public.encode_external_key(result)<>value THEN RAISE EXCEPTION 'Noncanonical compact external identifier'; END IF;
 RETURN result;
END $$;
--> statement-breakpoint
ALTER TABLE twitch_users ADD COLUMN storage_key bytea GENERATED ALWAYS AS (encode_external_key(twitch_user_id)) STORED,
 ADD CONSTRAINT twitch_users_storage_key_unique UNIQUE(storage_key);
--> statement-breakpoint
ALTER TABLE stream_sessions ADD COLUMN storage_key bytea GENERATED ALWAYS AS (encode_external_key(twitch_stream_id)) STORED,
 ADD CONSTRAINT stream_sessions_storage_key_unique UNIQUE(storage_key);
--> statement-breakpoint
-- Creation time is equal to its native observation anchor (0 bytes), a signed
-- microsecond delta (4 bytes), or an exact PostgreSQL timestamp (8 bytes).
-- An unchanged update time is NULL; subsequent updates remain native timestamps.
CREATE FUNCTION pack_record_time(anchor timestamptz, value timestamptz)
RETURNS bytea LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE delta numeric;
BEGIN
 IF value=anchor THEN RETURN decode('00','hex'); END IF;
 delta:=CASE WHEN isfinite(value) AND isfinite(anchor) THEN (extract(epoch FROM value)-extract(epoch FROM anchor))*1000000 END;
 IF delta BETWEEN -2147483648 AND 2147483647 THEN RETURN decode('01','hex')||int4send(delta::integer); END IF;
 RETURN decode('02','hex')||timestamptz_send(value);
END $$;
--> statement-breakpoint
CREATE FUNCTION unpack_record_time(payload bytea, anchor timestamptz)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE code integer; micros bigint;
BEGIN
 IF octet_length(payload)=0 THEN RAISE EXCEPTION 'Invalid record timestamp encoding'; END IF;
 code:=get_byte(payload,0);
 IF code>2 OR octet_length(payload)<>1+4*code THEN RAISE EXCEPTION 'Invalid record timestamp encoding'; END IF;
 IF code=0 THEN RETURN anchor; END IF;
 IF code=1 THEN
   micros:=('x'||encode(substring(payload FROM 2),'hex'))::bit(32)::integer;
   RETURN anchor+micros*interval '1 microsecond';
 END IF;
 micros:=('x'||encode(substring(payload FROM 2),'hex'))::bit(64)::bigint;
 RETURN CASE WHEN micros=9223372036854775807 THEN 'infinity'::timestamptz
   WHEN micros=(-9223372036854775807-1) THEN '-infinity'::timestamptz
   ELSE (timestamp '2000-01-01' + (micros/86400000000)*interval '1 day'
     + (micros%86400000000)*interval '1 microsecond') AT TIME ZONE 'UTC' END;
END $$;
--> statement-breakpoint
CREATE FUNCTION record_times_default() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE anchor timestamptz; old_anchor timestamptz;
BEGIN
 IF TG_ARGV[0]='observed_at' THEN anchor:=NEW.observed_at;
 ELSE anchor:=NEW.received_at; END IF;
 IF TG_OP='INSERT' THEN
   NEW.record_times:=coalesce(NEW.record_times,pack_record_time(anchor,now()));
 ELSE
   IF TG_ARGV[0]='observed_at' THEN old_anchor:=OLD.observed_at;
   ELSE old_anchor:=OLD.received_at; END IF;
   IF anchor IS DISTINCT FROM old_anchor AND NEW.record_times=OLD.record_times THEN
     NEW.record_times:=pack_record_time(anchor,unpack_record_time(OLD.record_times,old_anchor));
   END IF;
 END IF;
 RETURN NEW;
END $$;
