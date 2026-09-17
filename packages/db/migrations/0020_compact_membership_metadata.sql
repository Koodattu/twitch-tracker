SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL work_mem = '64MB';
--> statement-breakpoint
CREATE TABLE membership_event_rows (
  id uuid NOT NULL,
  received_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  broadcaster_user_id text NOT NULL,
  chatter_user_id text,
  chatter_login text,
  twitch_stream_id text,
  is_join boolean NOT NULL,
  event_time_kind smallint NOT NULL CHECK(event_time_kind BETWEEN 0 AND 2),
  identity_time_kind smallint NOT NULL CHECK(identity_time_kind BETWEEN 0 AND 2),
  event_at_override timestamptz,
  checked_at_override timestamptz,
  updated_at_override timestamptz,
  source_override text CHECK(source_override IS NULL OR left(source_override,1)='!'),
  confidence_override integer,
  dedupe_key_storage bytea,
  raw_irc_message_id uuid,
  irc_connection_id uuid,
  CHECK ((event_time_kind=1) = (event_at_override IS NOT NULL)),
  CHECK ((identity_time_kind=2) = (checked_at_override IS NOT NULL)),
  CONSTRAINT membership_digest_length CHECK(dedupe_key_storage IS NULL OR octet_length(dedupe_key_storage)=32 OR
    (octet_length(dedupe_key_storage)=0 AND public.derive_membership_key(broadcaster_user_id,twitch_stream_id,
      CASE WHEN is_join THEN 'join'::chat_membership_event_type ELSE 'part'::chat_membership_event_type END,chatter_login,
      CASE event_time_kind WHEN 0 THEN received_at WHEN 1 THEN event_at_override ELSE NULL END) IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO membership_event_rows
SELECT id,received_at,created_at,broadcaster_user_id,chatter_user_id,chatter_login,twitch_stream_id,event_type='join',
  CASE WHEN event_at IS NULL THEN 2 WHEN event_at=received_at THEN 0 ELSE 1 END,
  CASE WHEN identity_checked_at IS NULL THEN 0 WHEN identity_checked_at=received_at THEN 1 ELSE 2 END,
  CASE WHEN event_at IS DISTINCT FROM received_at THEN event_at END,
  CASE WHEN identity_checked_at IS DISTINCT FROM received_at THEN identity_checked_at END,
  nullif(updated_at,created_at),nullif(source,''),nullif(confidence,70),dedupe_key_storage,raw_irc_message_id,irc_connection_id
FROM chat_membership_events;
--> statement-breakpoint
DO $$ BEGIN
 IF (SELECT count(*) FROM membership_event_rows) <> (SELECT count(*) FROM chat_membership_events) THEN
   RAISE EXCEPTION 'Membership compaction lost rows';
 END IF;
END $$;
--> statement-breakpoint
ALTER TABLE membership_event_rows
 ADD PRIMARY KEY(id),
 ADD FOREIGN KEY(broadcaster_user_id) REFERENCES twitch_users(twitch_user_id),
 ADD FOREIGN KEY(chatter_user_id) REFERENCES twitch_users(twitch_user_id),
 ADD FOREIGN KEY(twitch_stream_id) REFERENCES stream_sessions(twitch_stream_id),
 ADD FOREIGN KEY(raw_irc_message_id) REFERENCES raw_irc_messages(id),
 ADD FOREIGN KEY(irc_connection_id) REFERENCES irc_connections(id);
--> statement-breakpoint
DROP TABLE chat_membership_events;
--> statement-breakpoint
CREATE UNIQUE INDEX chat_membership_events_dedupe_key_idx ON membership_event_rows(
 public.read_membership_key(broadcaster_user_id,twitch_stream_id,
 CASE WHEN is_join THEN 'join'::chat_membership_event_type ELSE 'part'::chat_membership_event_type END,chatter_login,
 CASE event_time_kind WHEN 0 THEN received_at WHEN 1 THEN event_at_override ELSE NULL END,dedupe_key_storage));
--> statement-breakpoint
CREATE INDEX membership_event_rows_chatter_received_idx ON membership_event_rows(chatter_user_id,received_at);
--> statement-breakpoint
CREATE INDEX membership_event_rows_unchecked_idx ON membership_event_rows(received_at)
 WHERE chatter_user_id IS NULL AND chatter_login IS NOT NULL
 AND (CASE identity_time_kind WHEN 0 THEN NULL WHEN 1 THEN received_at ELSE checked_at_override END) IS NULL;
--> statement-breakpoint
CREATE INDEX membership_event_rows_time_brin ON membership_event_rows USING brin(received_at,
 (coalesce(CASE event_time_kind WHEN 0 THEN received_at WHEN 1 THEN event_at_override ELSE NULL END,received_at)))
 WITH(pages_per_range=32,autosummarize=on);
--> statement-breakpoint
CREATE VIEW chat_membership_events AS
SELECT id,broadcaster_user_id,chatter_user_id,chatter_login,twitch_stream_id,
 CASE WHEN is_join THEN 'join'::chat_membership_event_type ELSE 'part'::chat_membership_event_type END AS event_type,
 CASE event_time_kind WHEN 0 THEN received_at WHEN 1 THEN event_at_override ELSE NULL END AS event_at,
 received_at,irc_connection_id,raw_irc_message_id,created_at,coalesce(updated_at_override,created_at) AS updated_at,
 coalesce(source_override,'') AS source,coalesce(confidence_override,70) AS confidence,dedupe_key_storage,
 CASE identity_time_kind WHEN 0 THEN NULL WHEN 1 THEN received_at ELSE checked_at_override END AS identity_checked_at
FROM membership_event_rows;
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
CREATE FUNCTION write_membership_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE digest bytea;
BEGIN
 IF TG_OP='DELETE' THEN
   DELETE FROM public.membership_event_rows WHERE id=OLD.id;
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
 IF NEW.dedupe_key_storage=decode('','hex') AND digest IS NULL THEN
   RAISE check_violation USING MESSAGE='membership_digest_length';
 END IF;
 IF digest=public.derive_membership_key(NEW.broadcaster_user_id,NEW.twitch_stream_id,NEW.event_type,NEW.chatter_login,NEW.event_at) THEN NEW.dedupe_key_storage:=decode('','hex');
 ELSE NEW.dedupe_key_storage:=digest; END IF;
 IF TG_OP='UPDATE' THEN
 UPDATE public.membership_event_rows SET id=NEW.id,received_at=NEW.received_at,created_at=NEW.created_at,
   broadcaster_user_id=NEW.broadcaster_user_id,chatter_user_id=NEW.chatter_user_id,chatter_login=NEW.chatter_login,twitch_stream_id=NEW.twitch_stream_id,
   is_join=NEW.event_type='join',
   event_time_kind=CASE WHEN NEW.event_at IS NULL THEN 2 WHEN NEW.event_at=NEW.received_at THEN 0 ELSE 1 END,
   identity_time_kind=CASE WHEN NEW.identity_checked_at IS NULL THEN 0 WHEN NEW.identity_checked_at=NEW.received_at THEN 1 ELSE 2 END,
   event_at_override=CASE WHEN NEW.event_at IS DISTINCT FROM NEW.received_at THEN NEW.event_at END,
   checked_at_override=CASE WHEN NEW.identity_checked_at IS DISTINCT FROM NEW.received_at THEN NEW.identity_checked_at END,
   updated_at_override=nullif(NEW.updated_at,NEW.created_at),source_override=nullif(NEW.source,''),confidence_override=nullif(NEW.confidence,70),
   dedupe_key_storage=NEW.dedupe_key_storage,raw_irc_message_id=NEW.raw_irc_message_id,irc_connection_id=NEW.irc_connection_id
 WHERE id=OLD.id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 ELSE
 INSERT INTO public.membership_event_rows VALUES(
   NEW.id,NEW.received_at,NEW.created_at,NEW.broadcaster_user_id,NEW.chatter_user_id,NEW.chatter_login,NEW.twitch_stream_id,NEW.event_type='join',
   CASE WHEN NEW.event_at IS NULL THEN 2 WHEN NEW.event_at=NEW.received_at THEN 0 ELSE 1 END,
   CASE WHEN NEW.identity_checked_at IS NULL THEN 0 WHEN NEW.identity_checked_at=NEW.received_at THEN 1 ELSE 2 END,
   CASE WHEN NEW.event_at IS DISTINCT FROM NEW.received_at THEN NEW.event_at END,
   CASE WHEN NEW.identity_checked_at IS DISTINCT FROM NEW.received_at THEN NEW.identity_checked_at END,
   nullif(NEW.updated_at,NEW.created_at),nullif(NEW.source,''),nullif(NEW.confidence,70),NEW.dedupe_key_storage,NEW.raw_irc_message_id,NEW.irc_connection_id);
 END IF;
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
ANALYZE membership_event_rows;
