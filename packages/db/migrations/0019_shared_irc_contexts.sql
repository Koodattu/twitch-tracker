SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE raw_irc_contexts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_login text,
  bot_account_id uuid REFERENCES bot_accounts(id),
  irc_connection_id uuid REFERENCES irc_connections(id),
  CONSTRAINT raw_irc_contexts_identity UNIQUE NULLS NOT DISTINCT (channel_login, bot_account_id, irc_connection_id)
);
--> statement-breakpoint
INSERT INTO raw_irc_contexts(channel_login, bot_account_id, irc_connection_id)
SELECT DISTINCT channel_login, bot_account_id, irc_connection_id FROM raw_irc_messages
WHERE channel_login IS NOT NULL OR bot_account_id IS NOT NULL OR irc_connection_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE raw_irc_messages ADD COLUMN context_id integer;
--> statement-breakpoint
UPDATE raw_irc_messages r SET context_id = c.id FROM raw_irc_contexts c
WHERE jsonb_build_array(r.channel_login, r.bot_account_id, r.irc_connection_id)
  = jsonb_build_array(c.channel_login, c.bot_account_id, c.irc_connection_id);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM raw_irc_messages r LEFT JOIN raw_irc_contexts c ON c.id = r.context_id
    WHERE (r.channel_login, r.bot_account_id, r.irc_connection_id)
      IS DISTINCT FROM (c.channel_login, c.bot_account_id, c.irc_connection_id)
  ) THEN RAISE EXCEPTION 'IRC context normalization changed metadata'; END IF;
END $$;
--> statement-breakpoint
-- Validate the reference after the bulk update rather than queue millions of FK trigger events.
ALTER TABLE raw_irc_messages DROP COLUMN channel_login, DROP COLUMN bot_account_id, DROP COLUMN irc_connection_id,
  ADD CONSTRAINT raw_irc_messages_context_id_raw_irc_contexts_id_fk FOREIGN KEY (context_id) REFERENCES raw_irc_contexts(id);
--> statement-breakpoint
CREATE FUNCTION get_raw_irc_context(channel text, bot_id uuid, connection_id uuid)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE context integer;
BEGIN
  IF channel IS NULL AND bot_id IS NULL AND connection_id IS NULL THEN RETURN NULL; END IF;
  IF channel IS NULL THEN
    SELECT id INTO context FROM public.raw_irc_contexts WHERE channel_login IS NULL
      AND bot_account_id IS NOT DISTINCT FROM bot_id AND irc_connection_id IS NOT DISTINCT FROM connection_id;
  ELSE
    SELECT id INTO context FROM public.raw_irc_contexts WHERE channel_login = channel
      AND bot_account_id IS NOT DISTINCT FROM bot_id AND irc_connection_id IS NOT DISTINCT FROM connection_id;
  END IF;
  IF FOUND THEN RETURN context; END IF;
  INSERT INTO public.raw_irc_contexts(channel_login, bot_account_id, irc_connection_id)
    VALUES(channel, bot_id, connection_id)
    ON CONFLICT ON CONSTRAINT raw_irc_contexts_identity DO UPDATE SET channel_login = raw_irc_contexts.channel_login
    RETURNING id INTO context;
  RETURN context;
END
$$;
--> statement-breakpoint
CREATE FUNCTION protect_raw_irc_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'IRC contexts are immutable; assign a different context instead'; END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER raw_irc_context_guard BEFORE UPDATE ON raw_irc_contexts
FOR EACH ROW EXECUTE FUNCTION protect_raw_irc_context();
