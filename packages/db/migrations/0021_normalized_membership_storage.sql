SET LOCAL lock_timeout='5s';
--> statement-breakpoint
SET LOCAL work_mem='64MB';
--> statement-breakpoint
CREATE FUNCTION membership_digest_bucket(digest bytea) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT ('x'||substr(encode(digest,'hex'),1,16))::bit(64)::bigint
$$;
--> statement-breakpoint
CREATE FUNCTION membership_event_uuid() RETURNS uuid LANGUAGE sql VOLATILE AS $$
 WITH random AS MATERIALIZED (
   SELECT substring(pg_catalog.int8send(floor(extract(epoch FROM clock_timestamp())*1000)::bigint) FROM 3)
     || substring(pg_catalog.uuid_send(gen_random_uuid()) FROM 7) AS bytes
 ) SELECT encode(set_byte(set_byte(bytes,6,(get_byte(bytes,6)&15)|112),8,(get_byte(bytes,8)&63)|128),'hex')::uuid FROM random
$$;
--> statement-breakpoint
CREATE TABLE membership_event_contexts (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 broadcaster_user_id text NOT NULL REFERENCES twitch_users(twitch_user_id),
 twitch_stream_id text REFERENCES stream_sessions(twitch_stream_id),
 UNIQUE NULLS NOT DISTINCT(broadcaster_user_id,twitch_stream_id)
);
--> statement-breakpoint
CREATE TABLE membership_event_identities (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 chatter_user_id text REFERENCES twitch_users(twitch_user_id),
 chatter_login text,
 pending_bucket timestamptz,
 resolved_at timestamptz,
 resolved_updated_at timestamptz,
 CHECK ((resolved_at IS NULL)=(resolved_updated_at IS NULL)),
 CHECK (pending_bucket IS NOT NULL OR resolved_at IS NULL),
 CHECK (pending_bucket IS NULL OR (chatter_login IS NOT NULL AND (chatter_user_id IS NULL OR resolved_at IS NOT NULL)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX membership_identity_pair_idx ON membership_event_identities(chatter_user_id,chatter_login)
 NULLS NOT DISTINCT WHERE pending_bucket IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX membership_identity_pending_idx ON membership_event_identities(chatter_login,pending_bucket)
 WHERE pending_bucket IS NOT NULL AND resolved_at IS NULL;
--> statement-breakpoint
CREATE INDEX membership_identity_login_idx ON membership_event_identities(chatter_login);
--> statement-breakpoint
CREATE INDEX membership_identity_user_idx ON membership_event_identities(chatter_user_id);
--> statement-breakpoint
INSERT INTO membership_event_contexts(broadcaster_user_id,twitch_stream_id)
SELECT DISTINCT broadcaster_user_id,twitch_stream_id FROM membership_event_rows;
--> statement-breakpoint
INSERT INTO membership_event_identities(chatter_user_id,chatter_login)
SELECT DISTINCT chatter_user_id,chatter_login FROM membership_event_rows;
--> statement-breakpoint
CREATE TABLE membership_events (
 id uuid NOT NULL,
 received_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL,
 digest_bucket bigint,
 context_id integer NOT NULL,
 identity_id integer NOT NULL,
 digest_slot smallint NOT NULL DEFAULT 0 CHECK(digest_slot>=0),
 event_time_kind smallint NOT NULL CHECK(event_time_kind BETWEEN 0 AND 2),
 identity_time_kind smallint NOT NULL CHECK(identity_time_kind BETWEEN 0 AND 2),
 is_join boolean NOT NULL,
 event_at_override timestamptz,
 checked_at_override timestamptz,
 updated_at_override timestamptz,
 source_override text CHECK(source_override IS NULL OR left(source_override,1)='!'),
 confidence_override integer,
 dedupe_key_storage bytea CHECK(dedupe_key_storage IS NULL OR octet_length(dedupe_key_storage) IN (0,32)),
 raw_irc_message_id uuid,
 irc_connection_id uuid,
 CHECK ((event_time_kind=1)=(event_at_override IS NOT NULL)),
 CHECK ((identity_time_kind=2)=(checked_at_override IS NOT NULL))
) WITH(autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.02);
--> statement-breakpoint
INSERT INTO membership_events
SELECT m.id,m.received_at,m.created_at,
 public.membership_digest_bucket(public.read_membership_key(m.broadcaster_user_id,m.twitch_stream_id,
   CASE WHEN m.is_join THEN 'join'::chat_membership_event_type ELSE 'part'::chat_membership_event_type END,m.chatter_login,
   CASE m.event_time_kind WHEN 0 THEN m.received_at WHEN 1 THEN m.event_at_override ELSE NULL END,m.dedupe_key_storage)),
 c.id,i.id,0,m.event_time_kind,m.identity_time_kind,m.is_join,m.event_at_override,m.checked_at_override,
 m.updated_at_override,m.source_override,m.confidence_override,m.dedupe_key_storage,m.raw_irc_message_id,m.irc_connection_id
FROM membership_event_rows m
JOIN membership_event_contexts c ON jsonb_build_array(c.broadcaster_user_id,c.twitch_stream_id)=jsonb_build_array(m.broadcaster_user_id,m.twitch_stream_id)
JOIN membership_event_identities i ON jsonb_build_array(i.chatter_user_id,i.chatter_login)=jsonb_build_array(m.chatter_user_id,m.chatter_login);
--> statement-breakpoint
WITH collisions AS (
 SELECT id,(row_number() OVER(PARTITION BY digest_bucket ORDER BY id)-1)::smallint AS slot
 FROM membership_events WHERE digest_bucket IN (
   SELECT digest_bucket FROM membership_events WHERE digest_bucket IS NOT NULL GROUP BY digest_bucket HAVING count(*)>1
 )
) UPDATE membership_events m SET digest_slot=c.slot FROM collisions c WHERE m.id=c.id;
--> statement-breakpoint
DO $$ BEGIN
 IF (SELECT count(*) FROM membership_events)<>(SELECT count(*) FROM membership_event_rows) THEN
   RAISE EXCEPTION 'Membership normalization lost rows';
 END IF;
END $$;
--> statement-breakpoint
ALTER TABLE membership_event_rows RENAME CONSTRAINT membership_event_rows_pkey TO membership_previous_pkey;
--> statement-breakpoint
ALTER TABLE membership_events
 ADD CONSTRAINT membership_event_rows_pkey PRIMARY KEY(id),
 ADD FOREIGN KEY(context_id) REFERENCES membership_event_contexts(id),
 ADD FOREIGN KEY(identity_id) REFERENCES membership_event_identities(id),
 ADD FOREIGN KEY(raw_irc_message_id) REFERENCES raw_irc_messages(id),
 ADD FOREIGN KEY(irc_connection_id) REFERENCES irc_connections(id);
--> statement-breakpoint
DROP FUNCTION insert_membership_event(text,text,text,text,chat_membership_event_type,timestamptz,timestamptz,bytea,uuid);
--> statement-breakpoint
DROP VIEW chat_membership_events;
--> statement-breakpoint
DROP FUNCTION write_membership_event();
--> statement-breakpoint
DROP TABLE membership_event_rows;
--> statement-breakpoint
CREATE UNIQUE INDEX membership_digest_slot_idx ON membership_events(digest_bucket,digest_slot);
--> statement-breakpoint
CREATE INDEX membership_events_identity_received_idx ON membership_events(identity_id,received_at);
--> statement-breakpoint
CREATE INDEX membership_events_unchecked_idx ON membership_events(received_at) WHERE identity_time_kind=0;
--> statement-breakpoint
CREATE INDEX membership_events_time_brin ON membership_events USING brin(received_at,
 (coalesce(CASE event_time_kind WHEN 0 THEN received_at WHEN 1 THEN event_at_override ELSE NULL END,received_at)))
 WITH(pages_per_range=32,autosummarize=on);
--> statement-breakpoint
CREATE VIEW chat_membership_events AS
SELECT r.id,c.broadcaster_user_id,i.chatter_user_id,i.chatter_login,c.twitch_stream_id,
 CASE WHEN r.is_join THEN 'join'::chat_membership_event_type ELSE 'part'::chat_membership_event_type END AS event_type,
 CASE r.event_time_kind WHEN 0 THEN r.received_at WHEN 1 THEN r.event_at_override ELSE NULL END AS event_at,
 r.received_at,r.irc_connection_id,r.raw_irc_message_id,r.created_at,
 coalesce(r.updated_at_override,i.resolved_updated_at,r.created_at) AS updated_at,
 coalesce(r.source_override,'') AS source,coalesce(r.confidence_override,70) AS confidence,r.dedupe_key_storage,
 CASE r.identity_time_kind WHEN 0 THEN i.resolved_at WHEN 1 THEN r.received_at ELSE r.checked_at_override END AS identity_checked_at
FROM membership_events r JOIN membership_event_contexts c ON c.id=r.context_id
JOIN membership_event_identities i ON i.id=r.identity_id;
--> statement-breakpoint
ALTER VIEW chat_membership_events ALTER COLUMN id SET DEFAULT membership_event_uuid();
--> statement-breakpoint
ALTER VIEW chat_membership_events ALTER COLUMN received_at SET DEFAULT now();
--> statement-breakpoint
ALTER VIEW chat_membership_events ALTER COLUMN created_at SET DEFAULT now();
--> statement-breakpoint
ALTER VIEW chat_membership_events ALTER COLUMN updated_at SET DEFAULT now();
--> statement-breakpoint
ALTER VIEW chat_membership_events ALTER COLUMN source SET DEFAULT '';
--> statement-breakpoint
ALTER VIEW chat_membership_events ALTER COLUMN confidence SET DEFAULT 70;
--> statement-breakpoint
CREATE FUNCTION protect_membership_dictionary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='membership_event_identities' THEN
   IF OLD.pending_bucket IS NOT NULL AND OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL
     AND (NEW.id,NEW.chatter_login,NEW.pending_bucket) IS NOT DISTINCT FROM (OLD.id,OLD.chatter_login,OLD.pending_bucket) THEN
     RETURN NEW;
   END IF;
 END IF;
 RAISE EXCEPTION 'Membership dictionaries are immutable except for closing pending identities';
END $$;
--> statement-breakpoint
CREATE TRIGGER membership_context_immutable BEFORE UPDATE ON membership_event_contexts
FOR EACH ROW EXECUTE FUNCTION protect_membership_dictionary();
--> statement-breakpoint
CREATE TRIGGER membership_identity_immutable BEFORE UPDATE ON membership_event_identities
FOR EACH ROW EXECUTE FUNCTION protect_membership_dictionary();
--> statement-breakpoint
CREATE FUNCTION get_membership_context(channel text,stream text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE result integer;
BEGIN
 LOOP
   SELECT id INTO result FROM public.membership_event_contexts
   WHERE broadcaster_user_id=channel AND twitch_stream_id IS NOT DISTINCT FROM stream FOR KEY SHARE;
   IF FOUND THEN RETURN result; END IF;
   BEGIN
     INSERT INTO public.membership_event_contexts(broadcaster_user_id,twitch_stream_id) VALUES(channel,stream) RETURNING id INTO result;
     RETURN result;
   EXCEPTION WHEN unique_violation THEN
     IF current_setting('transaction_isolation')<>'read committed' THEN RAISE serialization_failure USING MESSAGE='Retry membership context allocation'; END IF;
   END;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION get_membership_identity(person text,login text,observed timestamptz,cohort boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE result integer; bucket timestamptz;
BEGIN
 IF cohort AND person IS NULL AND login IS NOT NULL THEN
   bucket:=date_bin(interval '1 hour',observed,timestamptz '1970-01-01 00:00:00+00');
 END IF;
 LOOP
   IF bucket IS NOT NULL THEN
     SELECT id INTO result FROM public.membership_event_identities
     WHERE chatter_login=login AND pending_bucket=bucket AND resolved_at IS NULL FOR SHARE;
   ELSIF login IS NULL THEN
     SELECT id INTO result FROM public.membership_event_identities
     WHERE chatter_user_id IS NOT DISTINCT FROM person AND chatter_login IS NULL AND pending_bucket IS NULL FOR KEY SHARE;
   ELSE
     SELECT id INTO result FROM public.membership_event_identities
     WHERE chatter_user_id IS NOT DISTINCT FROM person AND chatter_login=login AND pending_bucket IS NULL FOR KEY SHARE;
   END IF;
   IF FOUND THEN RETURN result; END IF;
   BEGIN
     INSERT INTO public.membership_event_identities(chatter_user_id,chatter_login,pending_bucket) VALUES(person,login,bucket) RETURNING id INTO result;
     RETURN result;
   EXCEPTION WHEN unique_violation THEN
     IF current_setting('transaction_isolation')<>'read committed' THEN RAISE serialization_failure USING MESSAGE='Retry membership identity allocation'; END IF;
   END;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_membership_digest() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE digest bytea; excluded_id uuid; slot integer:=0;
BEGIN
 SELECT public.read_membership_key(c.broadcaster_user_id,c.twitch_stream_id,
   CASE WHEN NEW.is_join THEN 'join'::public.chat_membership_event_type ELSE 'part'::public.chat_membership_event_type END,i.chatter_login,
   CASE NEW.event_time_kind WHEN 0 THEN NEW.received_at WHEN 1 THEN NEW.event_at_override ELSE NULL END,NEW.dedupe_key_storage)
 INTO digest FROM public.membership_event_contexts c,public.membership_event_identities i WHERE c.id=NEW.context_id AND i.id=NEW.identity_id;
 IF NEW.dedupe_key_storage=decode('','hex') AND digest IS NULL THEN RAISE check_violation USING MESSAGE='membership_digest_length'; END IF;
 NEW.digest_bucket:=public.membership_digest_bucket(digest);
 NEW.digest_slot:=0;
 IF digest IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' THEN excluded_id:=OLD.id; END IF;
 IF EXISTS(SELECT 1 FROM public.membership_events r JOIN public.chat_membership_events m ON m.id=r.id
   WHERE r.digest_bucket=NEW.digest_bucket AND r.id IS DISTINCT FROM excluded_id
   AND public.read_membership_key(m.broadcaster_user_id,m.twitch_stream_id,m.event_type,m.chatter_login,m.event_at,m.dedupe_key_storage)=digest) THEN
   RAISE unique_violation USING MESSAGE='chat_membership_events_dedupe_key_idx',CONSTRAINT='chat_membership_events_dedupe_key_idx';
 END IF;
 WHILE EXISTS(SELECT 1 FROM public.membership_events WHERE digest_bucket=NEW.digest_bucket AND digest_slot=slot AND id IS DISTINCT FROM excluded_id) LOOP
   slot:=slot+1;
 END LOOP;
 NEW.digest_slot:=slot;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER membership_digest_guard BEFORE INSERT OR UPDATE ON membership_events FOR EACH ROW EXECUTE FUNCTION guard_membership_digest();
--> statement-breakpoint
CREATE FUNCTION write_membership_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE context_ref integer; identity_ref integer; digest bytea; violated text;
BEGIN
 IF TG_OP='DELETE' THEN
   DELETE FROM public.membership_events WHERE id=OLD.id;
   IF NOT FOUND THEN RETURN NULL; END IF;
   RETURN OLD;
 END IF;
 IF NEW.event_type IS NULL OR NEW.source IS NULL OR NEW.confidence IS NULL OR NEW.updated_at IS NULL THEN
   RAISE not_null_violation USING MESSAGE='Membership event fields cannot be null';
 END IF;
 IF TG_OP='UPDATE' AND NEW.dedupe_key_storage IS NOT DISTINCT FROM OLD.dedupe_key_storage THEN
   digest:=public.read_membership_key(OLD.broadcaster_user_id,OLD.twitch_stream_id,OLD.event_type,OLD.chatter_login,OLD.event_at,OLD.dedupe_key_storage);
 ELSE
   digest:=public.read_membership_key(NEW.broadcaster_user_id,NEW.twitch_stream_id,NEW.event_type,NEW.chatter_login,NEW.event_at,NEW.dedupe_key_storage);
 END IF;
 IF NEW.dedupe_key_storage=decode('','hex') AND digest IS NULL THEN RAISE check_violation USING MESSAGE='membership_digest_length'; END IF;
 IF digest=public.derive_membership_key(NEW.broadcaster_user_id,NEW.twitch_stream_id,NEW.event_type,NEW.chatter_login,NEW.event_at) THEN NEW.dedupe_key_storage:=decode('','hex');
 ELSE NEW.dedupe_key_storage:=digest; END IF;
 context_ref:=public.get_membership_context(NEW.broadcaster_user_id,NEW.twitch_stream_id);
 identity_ref:=public.get_membership_identity(NEW.chatter_user_id,NEW.chatter_login,NEW.received_at,
   TG_OP='INSERT' AND NEW.identity_checked_at IS NULL AND NEW.updated_at=NEW.created_at);
 LOOP
   BEGIN
     IF TG_OP='UPDATE' THEN
       UPDATE public.membership_events SET id=NEW.id,received_at=NEW.received_at,created_at=NEW.created_at,
         context_id=context_ref,identity_id=identity_ref,is_join=NEW.event_type='join',
         event_time_kind=CASE WHEN NEW.event_at IS NULL THEN 2 WHEN NEW.event_at=NEW.received_at THEN 0 ELSE 1 END,
         identity_time_kind=CASE WHEN NEW.identity_checked_at IS NULL THEN 0 WHEN NEW.identity_checked_at=NEW.received_at THEN 1 ELSE 2 END,
         event_at_override=CASE WHEN NEW.event_at IS DISTINCT FROM NEW.received_at THEN NEW.event_at END,
         checked_at_override=CASE WHEN NEW.identity_checked_at IS DISTINCT FROM NEW.received_at THEN NEW.identity_checked_at END,
         updated_at_override=nullif(NEW.updated_at,NEW.created_at),source_override=nullif(NEW.source,''),confidence_override=nullif(NEW.confidence,70),
         dedupe_key_storage=NEW.dedupe_key_storage,raw_irc_message_id=NEW.raw_irc_message_id,irc_connection_id=NEW.irc_connection_id
       WHERE id=OLD.id;
       IF NOT FOUND THEN RETURN NULL; END IF;
     ELSE
       INSERT INTO public.membership_events(id,received_at,created_at,context_id,identity_id,is_join,event_time_kind,identity_time_kind,
         event_at_override,checked_at_override,updated_at_override,source_override,confidence_override,dedupe_key_storage,raw_irc_message_id,irc_connection_id)
       VALUES(NEW.id,NEW.received_at,NEW.created_at,context_ref,identity_ref,NEW.event_type='join',
         CASE WHEN NEW.event_at IS NULL THEN 2 WHEN NEW.event_at=NEW.received_at THEN 0 ELSE 1 END,
         CASE WHEN NEW.identity_checked_at IS NULL THEN 0 WHEN NEW.identity_checked_at=NEW.received_at THEN 1 ELSE 2 END,
         CASE WHEN NEW.event_at IS DISTINCT FROM NEW.received_at THEN NEW.event_at END,
         CASE WHEN NEW.identity_checked_at IS DISTINCT FROM NEW.received_at THEN NEW.identity_checked_at END,
         nullif(NEW.updated_at,NEW.created_at),nullif(NEW.source,''),nullif(NEW.confidence,70),NEW.dedupe_key_storage,NEW.raw_irc_message_id,NEW.irc_connection_id);
     END IF;
     RETURN NEW;
   EXCEPTION WHEN unique_violation THEN
     GET STACKED DIAGNOSTICS violated=CONSTRAINT_NAME;
     IF violated<>'membership_digest_slot_idx' THEN RAISE; END IF;
     IF current_setting('transaction_isolation')<>'read committed' THEN RAISE serialization_failure USING MESSAGE='Retry membership deduplication'; END IF;
   END;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER membership_event_write INSTEAD OF INSERT OR UPDATE OR DELETE ON chat_membership_events FOR EACH ROW EXECUTE FUNCTION write_membership_event();
--> statement-breakpoint
CREATE FUNCTION insert_membership_event(channel text,person text,login text,stream text,kind chat_membership_event_type,
 observed timestamptz,checked timestamptz,digest bytea DEFAULT decode('','hex'),raw_id uuid DEFAULT NULL)
RETURNS SETOF chat_membership_events LANGUAGE plpgsql AS $$
DECLARE violated text;
BEGIN
 RETURN QUERY INSERT INTO public.chat_membership_events(broadcaster_user_id,chatter_user_id,chatter_login,twitch_stream_id,
   event_type,event_at,received_at,identity_checked_at,dedupe_key_storage,raw_irc_message_id)
 VALUES(channel,person,login,stream,kind,observed,coalesce(observed,now()),checked,digest,raw_id) RETURNING *;
EXCEPTION WHEN unique_violation THEN
 GET STACKED DIAGNOSTICS violated=CONSTRAINT_NAME;
 IF violated NOT IN ('chat_membership_events_dedupe_key_idx','membership_event_rows_pkey') THEN RAISE; END IF;
 RETURN;
END $$;
--> statement-breakpoint
CREATE FUNCTION resolve_membership_identity(login text,person text,since timestamptz,until_at timestamptz,checked timestamptz,updated timestamptz)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE identity_ref integer; earliest timestamptz; latest timestamptz; events integer; resolved integer:=0; extra integer;
BEGIN
 FOR identity_ref IN SELECT id FROM public.membership_event_identities
   WHERE chatter_login=login AND pending_bucket IS NOT NULL AND resolved_at IS NULL ORDER BY id FOR UPDATE LOOP
   SELECT min(received_at),max(received_at),count(*)::integer INTO earliest,latest,events FROM public.membership_events WHERE identity_id=identity_ref;
   IF earliest>=since AND latest<=until_at THEN
     UPDATE public.membership_event_identities SET chatter_user_id=person,resolved_at=checked,resolved_updated_at=updated WHERE id=identity_ref;
     IF person IS NOT NULL THEN resolved:=resolved+events; END IF;
   END IF;
 END LOOP;
 WITH changed AS (
   UPDATE public.chat_membership_events SET chatter_user_id=person,identity_checked_at=checked,updated_at=updated
   WHERE chatter_user_id IS NULL AND identity_checked_at IS NULL AND chatter_login=login AND received_at>=since AND received_at<=until_at
   RETURNING chatter_user_id
 ) SELECT count(chatter_user_id)::integer INTO extra FROM changed;
 RETURN resolved+extra;
END $$;
--> statement-breakpoint
CREATE FUNCTION prune_membership_subject(person text,login text) RETURNS void LANGUAGE sql AS $$
 DELETE FROM public.membership_event_identities i
 WHERE (i.chatter_user_id=person OR (login<>'' AND i.chatter_login=login))
 AND NOT EXISTS(SELECT 1 FROM public.membership_events r WHERE r.identity_id=i.id)
$$;
--> statement-breakpoint
ANALYZE membership_event_contexts;
--> statement-breakpoint
ANALYZE membership_event_identities;
--> statement-breakpoint
ANALYZE membership_events;
