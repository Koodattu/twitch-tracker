-- Local experiment only. The runner substitutes a validated schema identifier.
CREATE TYPE __SCHEMA__.processing_status AS ENUM ('pending','processed','failed','ignored');
CREATE TABLE __SCHEMA__.contexts (
  id integer PRIMARY KEY,
  channel_login text,
  bot_account_id uuid,
  irc_connection_id uuid,
  UNIQUE NULLS NOT DISTINCT(channel_login,bot_account_id,irc_connection_id)
);
CREATE TABLE __SCHEMA__.blocks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lines text[] COMPRESSION pglz NOT NULL CHECK(cardinality(lines) BETWEEN 1 AND 256)
);
CREATE TABLE __SCHEMA__.raw (
  id uuid PRIMARY KEY,
  raw_line text NOT NULL,
  parsed_command text,
  tags bytea NOT NULL,
  received_at timestamptz NOT NULL,
  processing_status __SCHEMA__.processing_status NOT NULL,
  parse_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload_block_id bigint REFERENCES __SCHEMA__.blocks(id),
  payload_position smallint,
  unrelayed_source boolean,
  context_id integer REFERENCES __SCHEMA__.contexts(id),
  CHECK ((payload_block_id IS NULL AND payload_position IS NULL) OR
    (payload_block_id IS NOT NULL AND payload_position BETWEEN 1 AND 256 AND raw_line=''))
);
CREATE INDEX raw_received_idx ON __SCHEMA__.raw(received_at);
CREATE INDEX raw_unpacked_idx ON __SCHEMA__.raw(received_at)
  WHERE payload_block_id IS NULL AND raw_line<>'';
CREATE FUNCTION __SCHEMA__.wire(inline_line text, block_id bigint, slot smallint)
RETURNS text LANGUAGE plpgsql STABLE SET search_path=__SCHEMA__,pg_catalog AS $$
DECLARE result text;
BEGIN
  IF block_id IS NULL THEN RETURN inline_line; END IF;
  SELECT lines[slot] INTO result FROM blocks WHERE id=block_id;
  IF result IS NULL THEN RAISE EXCEPTION 'Missing archived payload'; END IF;
  RETURN result;
END $$;
CREATE FUNCTION __SCHEMA__.protect_wire() RETURNS trigger LANGUAGE plpgsql
SET search_path=__SCHEMA__,pg_catalog AS $$
BEGIN
  IF OLD.payload_block_id IS NOT NULL THEN
    UPDATE blocks SET lines[OLD.payload_position]=NULL WHERE id=OLD.payload_block_id;
    IF TG_OP='UPDATE' THEN
      NEW.payload_block_id:=NULL; NEW.payload_position:=NULL; NEW.unrelayed_source:=NULL;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER protect_wire BEFORE UPDATE OF raw_line OR DELETE ON __SCHEMA__.raw
FOR EACH ROW EXECUTE FUNCTION __SCHEMA__.protect_wire();
CREATE FUNCTION __SCHEMA__.pack(cutoff timestamptz, batch_size integer DEFAULT 256)
RETURNS integer LANGUAGE plpgsql SET search_path=__SCHEMA__,pg_catalog AS $$
DECLARE ids uuid[]; wires text[]; block_id bigint; changed integer;
BEGIN
  IF batch_size IS NULL OR batch_size NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'Invalid batch size'; END IF;
  SELECT array_agg(id ORDER BY received_at,id),array_agg(raw_line ORDER BY received_at,id)
  INTO ids,wires FROM (SELECT id,raw_line,received_at FROM raw
    WHERE payload_block_id IS NULL AND raw_line<>'' AND received_at<cutoff
    ORDER BY received_at,id LIMIT batch_size FOR UPDATE SKIP LOCKED) selected;
  IF ids IS NULL THEN RETURN 0; END IF;
  INSERT INTO blocks(lines) VALUES(wires) RETURNING id INTO block_id;
  IF (SELECT lines FROM blocks WHERE id=block_id) IS DISTINCT FROM wires THEN RAISE EXCEPTION 'Wire mismatch'; END IF;
  UPDATE raw r SET payload_block_id=block_id,payload_position=p.slot::smallint,
    unrelayed_source=r.raw_line LIKE '@%' AND split_part(r.raw_line,' ',1) !~ '(?:^@|;)source-room-id=[^;]+',raw_line=''
    FROM unnest(ids) WITH ORDINALITY p(id,slot) WHERE r.id=p.id;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>cardinality(ids) THEN RAISE EXCEPTION 'Packing row count mismatch'; END IF;
  RETURN changed;
END $$;
CREATE FUNCTION __SCHEMA__.replace_wire(target uuid, replacement text, new_tags bytea, new_error text, changed_at timestamptz)
RETURNS void LANGUAGE sql SET search_path=__SCHEMA__,pg_catalog AS $$
  UPDATE raw SET raw_line=replacement,tags=new_tags,parse_error=new_error,updated_at=changed_at WHERE id=target;
$$;
CREATE FUNCTION __SCHEMA__.remove_raw(target uuid) RETURNS void LANGUAGE sql
SET search_path=__SCHEMA__,pg_catalog AS $$ DELETE FROM raw WHERE id=target; $$;
