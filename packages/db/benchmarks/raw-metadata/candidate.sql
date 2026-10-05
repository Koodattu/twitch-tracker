-- Build the candidate from the same empty schema as the baseline. No index is retired.
DROP TRIGGER protect_wire ON __SCHEMA__.raw;
DROP FUNCTION __SCHEMA__.protect_wire();
DROP FUNCTION __SCHEMA__.replace_wire(uuid,text,bytea,text,timestamptz);
DROP FUNCTION __SCHEMA__.remove_raw(uuid);
DROP FUNCTION __SCHEMA__.pack(timestamptz,integer);
DROP TABLE __SCHEMA__.raw;
CREATE TYPE __SCHEMA__.metadata AS (
  tags bytea,processing_status __SCHEMA__.processing_status,
  parse_error text,created_at timestamptz,updated_at timestamptz
);
ALTER TABLE __SCHEMA__.blocks ADD COLUMN metadata __SCHEMA__.metadata[] COMPRESSION pglz NOT NULL;
ALTER TABLE __SCHEMA__.blocks ADD CHECK(cardinality(metadata)=cardinality(lines));
CREATE TABLE __SCHEMA__.keys (
  id uuid PRIMARY KEY,
  received_at timestamptz NOT NULL,
  payload_block_id bigint REFERENCES __SCHEMA__.blocks(id),
  payload_position smallint,
  context_id integer REFERENCES __SCHEMA__.contexts(id),
  parsed_command text,
  unrelayed_source boolean,
  has_inline_line boolean NOT NULL,
  CHECK ((payload_block_id IS NULL AND payload_position IS NULL) OR
    (payload_block_id IS NOT NULL AND payload_position BETWEEN 1 AND 256 AND NOT has_inline_line))
);
CREATE INDEX raw_received_idx ON __SCHEMA__.keys(received_at);
CREATE INDEX raw_unpacked_idx ON __SCHEMA__.keys(received_at)
  WHERE payload_block_id IS NULL AND has_inline_line;
CREATE TABLE __SCHEMA__.hot (
  id uuid PRIMARY KEY REFERENCES __SCHEMA__.keys(id) ON DELETE CASCADE,
  raw_line text NOT NULL,
  tags bytea NOT NULL,
  processing_status __SCHEMA__.processing_status NOT NULL,
  parse_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE VIEW __SCHEMA__.raw AS SELECT k.id,coalesce(h.raw_line,'') AS raw_line,k.parsed_command,
  CASE WHEN k.payload_block_id IS NULL THEN h.tags ELSE (b.metadata[k.payload_position]).tags END AS tags,
  k.received_at,
  CASE WHEN k.payload_block_id IS NULL THEN h.processing_status ELSE (b.metadata[k.payload_position]).processing_status END AS processing_status,
  CASE WHEN k.payload_block_id IS NULL THEN h.parse_error ELSE (b.metadata[k.payload_position]).parse_error END AS parse_error,
  CASE WHEN k.payload_block_id IS NULL THEN h.created_at ELSE (b.metadata[k.payload_position]).created_at END AS created_at,
  CASE WHEN k.payload_block_id IS NULL THEN h.updated_at ELSE (b.metadata[k.payload_position]).updated_at END AS updated_at,
  k.payload_block_id,k.payload_position,k.unrelayed_source,k.context_id
FROM __SCHEMA__.keys k
LEFT JOIN __SCHEMA__.hot h ON h.id=k.id
LEFT JOIN __SCHEMA__.blocks b ON b.id=k.payload_block_id;
CREATE FUNCTION __SCHEMA__.pack(cutoff timestamptz, batch_size integer DEFAULT 256)
RETURNS integer LANGUAGE plpgsql SET search_path=__SCHEMA__,pg_catalog AS $$
DECLARE ids uuid[]; wires text[]; metas metadata[]; block_id bigint; changed integer;
BEGIN
  IF batch_size IS NULL OR batch_size NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'Invalid batch size'; END IF;
  SELECT array_agg(id ORDER BY received_at,id),array_agg(raw_line ORDER BY received_at,id),
    array_agg(ROW(tags,processing_status,parse_error,created_at,updated_at)::metadata ORDER BY received_at,id)
  INTO ids,wires,metas FROM (SELECT k.id,k.received_at,h.raw_line,h.tags,h.processing_status,h.parse_error,h.created_at,h.updated_at
    FROM keys k JOIN hot h USING(id)
    WHERE k.payload_block_id IS NULL AND k.has_inline_line AND k.received_at<cutoff
    ORDER BY k.received_at,k.id LIMIT batch_size FOR UPDATE OF k SKIP LOCKED) selected;
  IF ids IS NULL THEN RETURN 0; END IF;
  INSERT INTO blocks(lines,metadata) VALUES(wires,metas) RETURNING id INTO block_id;
  IF EXISTS(SELECT 1 FROM blocks WHERE id=block_id AND (lines IS DISTINCT FROM wires OR metadata IS DISTINCT FROM metas)) THEN
    RAISE EXCEPTION 'Packed reconstruction mismatch';
  END IF;
  UPDATE keys k SET payload_block_id=block_id,payload_position=p.slot::smallint,
    unrelayed_source=h.raw_line LIKE '@%' AND split_part(h.raw_line,' ',1) !~ '(?:^@|;)source-room-id=[^;]+',has_inline_line=false
    FROM unnest(ids) WITH ORDINALITY p(id,slot),hot h WHERE k.id=p.id AND h.id=k.id;
  GET DIAGNOSTICS changed=ROW_COUNT;
  IF changed<>cardinality(ids) THEN RAISE EXCEPTION 'Packing row count mismatch'; END IF;
  DELETE FROM hot WHERE id=ANY(ids);
  RETURN changed;
END $$;
CREATE FUNCTION __SCHEMA__.replace_wire(target uuid, replacement text, new_tags bytea, new_error text, changed_at timestamptz)
RETURNS void LANGUAGE plpgsql SET search_path=__SCHEMA__,pg_catalog AS $$
DECLARE previous raw%ROWTYPE;
BEGIN
  -- The stable key serializes with packing and deletion; read metadata only after taking that lock.
  PERFORM 1 FROM keys WHERE id=target FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO STRICT previous FROM raw WHERE id=target;
  IF previous.payload_block_id IS NOT NULL THEN
    UPDATE blocks SET lines[previous.payload_position]=NULL,metadata[previous.payload_position]=NULL WHERE id=previous.payload_block_id;
  END IF;
  INSERT INTO hot VALUES(target,replacement,new_tags,previous.processing_status,new_error,previous.created_at,changed_at)
    ON CONFLICT(id) DO UPDATE SET raw_line=excluded.raw_line,tags=excluded.tags,parse_error=excluded.parse_error,updated_at=excluded.updated_at;
  UPDATE keys SET payload_block_id=NULL,payload_position=NULL,unrelayed_source=NULL,has_inline_line=replacement<>'' WHERE id=target;
END $$;
CREATE FUNCTION __SCHEMA__.remove_raw(target uuid) RETURNS void LANGUAGE plpgsql
SET search_path=__SCHEMA__,pg_catalog AS $$
DECLARE previous keys%ROWTYPE;
BEGIN
  SELECT * INTO previous FROM keys WHERE id=target FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF previous.payload_block_id IS NOT NULL THEN
    UPDATE blocks SET lines[previous.payload_position]=NULL,metadata[previous.payload_position]=NULL WHERE id=previous.payload_block_id;
  END IF;
  DELETE FROM keys WHERE id=target;
END $$;
