SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL work_mem = '64MB';
--> statement-breakpoint
CREATE TABLE membership_event_contexts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  broadcaster_user_id text NOT NULL REFERENCES twitch_users(twitch_user_id),
  twitch_stream_id text REFERENCES stream_sessions(twitch_stream_id),
  UNIQUE NULLS NOT DISTINCT (broadcaster_user_id, twitch_stream_id)
);
--> statement-breakpoint
CREATE TABLE membership_event_identities (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chatter_user_id text REFERENCES twitch_users(twitch_user_id),
  chatter_login text,
  UNIQUE NULLS NOT DISTINCT (chatter_user_id, chatter_login)
);
--> statement-breakpoint
CREATE INDEX membership_event_identities_login_idx ON membership_event_identities(chatter_login);
--> statement-breakpoint
INSERT INTO membership_event_contexts(broadcaster_user_id,twitch_stream_id)
SELECT DISTINCT broadcaster_user_id,twitch_stream_id FROM chat_membership_events;
--> statement-breakpoint
INSERT INTO membership_event_identities(chatter_user_id,chatter_login)
SELECT DISTINCT chatter_user_id,chatter_login FROM chat_membership_events;
--> statement-breakpoint
CREATE TABLE membership_event_rows (
  id uuid NOT NULL,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  context_id integer NOT NULL,
  identity_id integer NOT NULL,
  is_join boolean NOT NULL,
  event_time_kind smallint NOT NULL CHECK(event_time_kind BETWEEN 0 AND 2),
  identity_time_kind smallint NOT NULL CHECK(identity_time_kind BETWEEN 0 AND 2),
  event_at_override timestamptz,
  checked_at_override timestamptz,
  updated_at_override timestamptz,
  source_override text CHECK(source_override IS NULL OR left(source_override,1)='!'),
  confidence_override integer,
  dedupe_key bytea CHECK(dedupe_key IS NULL OR octet_length(dedupe_key)=32),
  raw_irc_message_id uuid,
  irc_connection_id uuid,
  CHECK ((event_time_kind=1) = (event_at_override IS NOT NULL)),
  CHECK ((identity_time_kind=2) = (checked_at_override IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO membership_event_rows
SELECT m.id,m.received_at,m.created_at,c.id,i.id,m.event_type='join',
  CASE WHEN m.event_at IS NULL THEN 2 WHEN m.event_at=m.received_at THEN 0 ELSE 1 END,
  CASE WHEN m.identity_checked_at IS NULL THEN 0 WHEN m.identity_checked_at=m.received_at THEN 1 ELSE 2 END,
  CASE WHEN m.event_at IS DISTINCT FROM m.received_at THEN m.event_at END,
  CASE WHEN m.identity_checked_at IS DISTINCT FROM m.received_at THEN m.identity_checked_at END,
  nullif(m.updated_at,m.created_at),nullif(m.source,''),nullif(m.confidence,70),
  read_membership_key(m.broadcaster_user_id,m.twitch_stream_id,m.event_type,m.chatter_login,m.event_at,m.dedupe_key_storage),
  m.raw_irc_message_id,m.irc_connection_id
FROM chat_membership_events m
JOIN membership_event_contexts c ON jsonb_build_array(c.broadcaster_user_id,c.twitch_stream_id)=jsonb_build_array(m.broadcaster_user_id,m.twitch_stream_id)
JOIN membership_event_identities i ON jsonb_build_array(i.chatter_user_id,i.chatter_login)=jsonb_build_array(m.chatter_user_id,m.chatter_login);
--> statement-breakpoint
DO $$ BEGIN
 IF (SELECT count(*) FROM membership_event_rows) <> (SELECT count(*) FROM chat_membership_events) THEN
   RAISE EXCEPTION 'Membership normalization lost rows';
 END IF;
END $$;
--> statement-breakpoint
ALTER TABLE membership_event_rows
 ADD PRIMARY KEY(id),
 ADD FOREIGN KEY(context_id) REFERENCES membership_event_contexts(id),
 ADD FOREIGN KEY(identity_id) REFERENCES membership_event_identities(id),
 ADD FOREIGN KEY(raw_irc_message_id) REFERENCES raw_irc_messages(id),
 ADD FOREIGN KEY(irc_connection_id) REFERENCES irc_connections(id);
--> statement-breakpoint
DROP TABLE chat_membership_events;
--> statement-breakpoint
CREATE UNIQUE INDEX chat_membership_events_dedupe_key_idx ON membership_event_rows(dedupe_key);
--> statement-breakpoint
CREATE INDEX membership_event_rows_identity_received_idx ON membership_event_rows(identity_id,received_at);
--> statement-breakpoint
CREATE INDEX membership_event_rows_unchecked_idx ON membership_event_rows(received_at)
 WHERE (CASE identity_time_kind WHEN 0 THEN NULL WHEN 1 THEN received_at ELSE checked_at_override END) IS NULL;
--> statement-breakpoint
CREATE INDEX membership_event_rows_time_brin ON membership_event_rows USING brin(received_at,
 (coalesce(CASE event_time_kind WHEN 0 THEN received_at WHEN 1 THEN event_at_override ELSE NULL END,received_at)))
 WITH(pages_per_range=32,autosummarize=on);
--> statement-breakpoint
CREATE VIEW chat_membership_events AS
SELECT r.id,c.broadcaster_user_id,i.chatter_user_id,i.chatter_login,c.twitch_stream_id,
 CASE WHEN r.is_join THEN 'join'::chat_membership_event_type ELSE 'part'::chat_membership_event_type END AS event_type,
 CASE r.event_time_kind WHEN 0 THEN r.received_at WHEN 1 THEN r.event_at_override ELSE NULL END AS event_at,
 r.received_at,r.irc_connection_id,r.raw_irc_message_id,r.created_at,coalesce(r.updated_at_override,r.created_at) AS updated_at,
 coalesce(r.source_override,'') AS source,coalesce(r.confidence_override,70) AS confidence,
 CASE WHEN r.dedupe_key=public.derive_membership_key(c.broadcaster_user_id,c.twitch_stream_id,
   CASE WHEN r.is_join THEN 'join'::chat_membership_event_type ELSE 'part'::chat_membership_event_type END,i.chatter_login,
   CASE r.event_time_kind WHEN 0 THEN r.received_at WHEN 1 THEN r.event_at_override ELSE NULL END)
 THEN decode('','hex') ELSE r.dedupe_key END AS dedupe_key_storage,
 CASE r.identity_time_kind WHEN 0 THEN NULL WHEN 1 THEN r.received_at ELSE r.checked_at_override END AS identity_checked_at
FROM membership_event_rows r
JOIN membership_event_contexts c ON c.id=r.context_id
JOIN membership_event_identities i ON i.id=r.identity_id;
--> statement-breakpoint
ALTER VIEW chat_membership_events ALTER COLUMN id SET DEFAULT gen_random_uuid();
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
 IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Membership dictionaries are immutable'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER membership_context_immutable BEFORE UPDATE ON membership_event_contexts FOR EACH ROW EXECUTE FUNCTION protect_membership_dictionary();
--> statement-breakpoint
CREATE TRIGGER membership_identity_immutable BEFORE UPDATE ON membership_event_identities FOR EACH ROW EXECUTE FUNCTION protect_membership_dictionary();
--> statement-breakpoint
CREATE FUNCTION write_membership_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE context integer; identity integer; digest bytea;
BEGIN
 IF TG_OP='DELETE' THEN
   DELETE FROM public.membership_event_rows WHERE id=OLD.id;
   RETURN OLD;
 END IF;
 IF NEW.event_type IS NULL OR NEW.source IS NULL OR NEW.confidence IS NULL OR NEW.updated_at IS NULL THEN
   RAISE not_null_violation USING MESSAGE='Membership event fields cannot be null';
 END IF;
 IF TG_OP='UPDATE' AND NEW.dedupe_key_storage IS NOT DISTINCT FROM OLD.dedupe_key_storage THEN
   SELECT dedupe_key INTO digest FROM public.membership_event_rows WHERE id=OLD.id FOR UPDATE;
 ELSE
   digest:=public.read_membership_key(NEW.broadcaster_user_id,NEW.twitch_stream_id,NEW.event_type,NEW.chatter_login,NEW.event_at,NEW.dedupe_key_storage);
 END IF;
 IF NEW.dedupe_key_storage=decode('','hex') AND digest IS NULL THEN
   RAISE check_violation USING MESSAGE='membership_digest_length';
 END IF;
 SELECT id INTO context FROM public.membership_event_contexts
 WHERE broadcaster_user_id=NEW.broadcaster_user_id AND twitch_stream_id IS NOT DISTINCT FROM NEW.twitch_stream_id FOR KEY SHARE;
 IF NOT FOUND THEN
   INSERT INTO public.membership_event_contexts(broadcaster_user_id,twitch_stream_id) VALUES(NEW.broadcaster_user_id,NEW.twitch_stream_id)
   ON CONFLICT(broadcaster_user_id,twitch_stream_id) DO UPDATE SET broadcaster_user_id=membership_event_contexts.broadcaster_user_id RETURNING id INTO context;
 END IF;
 IF NEW.chatter_login IS NULL THEN
   SELECT id INTO identity FROM public.membership_event_identities
   WHERE chatter_login IS NULL AND chatter_user_id IS NOT DISTINCT FROM NEW.chatter_user_id FOR KEY SHARE;
 ELSE
   SELECT id INTO identity FROM public.membership_event_identities
   WHERE chatter_login=NEW.chatter_login AND chatter_user_id IS NOT DISTINCT FROM NEW.chatter_user_id FOR KEY SHARE;
 END IF;
 IF NOT FOUND THEN
   INSERT INTO public.membership_event_identities(chatter_user_id,chatter_login) VALUES(NEW.chatter_user_id,NEW.chatter_login)
   ON CONFLICT(chatter_user_id,chatter_login) DO UPDATE SET chatter_login=membership_event_identities.chatter_login RETURNING id INTO identity;
 END IF;
 IF TG_OP='UPDATE' THEN
 UPDATE public.membership_event_rows SET id=NEW.id,received_at=NEW.received_at,created_at=NEW.created_at,
   context_id=context,identity_id=identity,is_join=NEW.event_type='join',
   event_time_kind=CASE WHEN NEW.event_at IS NULL THEN 2 WHEN NEW.event_at=NEW.received_at THEN 0 ELSE 1 END,
   identity_time_kind=CASE WHEN NEW.identity_checked_at IS NULL THEN 0 WHEN NEW.identity_checked_at=NEW.received_at THEN 1 ELSE 2 END,
   event_at_override=CASE WHEN NEW.event_at IS DISTINCT FROM NEW.received_at THEN NEW.event_at END,
   checked_at_override=CASE WHEN NEW.identity_checked_at IS DISTINCT FROM NEW.received_at THEN NEW.identity_checked_at END,
   updated_at_override=nullif(NEW.updated_at,NEW.created_at),source_override=nullif(NEW.source,''),confidence_override=nullif(NEW.confidence,70),
   dedupe_key=digest,raw_irc_message_id=NEW.raw_irc_message_id,irc_connection_id=NEW.irc_connection_id
 WHERE id=OLD.id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 ELSE
 INSERT INTO public.membership_event_rows VALUES(
   NEW.id,NEW.received_at,NEW.created_at,context,identity,NEW.event_type='join',
   CASE WHEN NEW.event_at IS NULL THEN 2 WHEN NEW.event_at=NEW.received_at THEN 0 ELSE 1 END,
   CASE WHEN NEW.identity_checked_at IS NULL THEN 0 WHEN NEW.identity_checked_at=NEW.received_at THEN 1 ELSE 2 END,
   CASE WHEN NEW.event_at IS DISTINCT FROM NEW.received_at THEN NEW.event_at END,
   CASE WHEN NEW.identity_checked_at IS DISTINCT FROM NEW.received_at THEN NEW.identity_checked_at END,
   nullif(NEW.updated_at,NEW.created_at),nullif(NEW.source,''),nullif(NEW.confidence,70),digest,NEW.raw_irc_message_id,NEW.irc_connection_id);
 END IF;
 IF digest=public.derive_membership_key(NEW.broadcaster_user_id,NEW.twitch_stream_id,NEW.event_type,NEW.chatter_login,NEW.event_at) THEN NEW.dedupe_key_storage:=decode('','hex');
 ELSE NEW.dedupe_key_storage:=digest; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER membership_event_write INSTEAD OF INSERT OR UPDATE OR DELETE ON chat_membership_events
FOR EACH ROW EXECUTE FUNCTION write_membership_event();
--> statement-breakpoint
CREATE FUNCTION insert_membership_event(channel text, person text, login text, stream text, kind chat_membership_event_type,
 observed timestamptz, checked timestamptz, digest bytea DEFAULT decode('','hex'), raw_id uuid DEFAULT NULL)
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
ANALYZE membership_event_contexts;
--> statement-breakpoint
ANALYZE membership_event_identities;
--> statement-breakpoint
ANALYZE membership_event_rows;
