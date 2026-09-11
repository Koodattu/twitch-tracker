SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE raw_irc_payload_blocks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lines text[] COMPRESSION pglz NOT NULL CHECK (cardinality(lines) BETWEEN 1 AND 256)
);
--> statement-breakpoint
ALTER TABLE raw_irc_messages
  ADD COLUMN payload_block_id bigint REFERENCES raw_irc_payload_blocks(id),
  ADD COLUMN payload_position smallint,
  ADD COLUMN unrelayed_source boolean,
  ADD CONSTRAINT raw_irc_payload_location CHECK (
    (payload_block_id IS NULL AND payload_position IS NULL)
    OR (payload_block_id IS NOT NULL AND payload_position IS NOT NULL AND payload_position BETWEEN 1 AND 256 AND raw_line = '')
  );
--> statement-breakpoint
CREATE INDEX raw_irc_messages_unpacked_idx ON raw_irc_messages (received_at)
  WHERE payload_block_id IS NULL AND raw_line <> '';
--> statement-breakpoint
CREATE FUNCTION read_raw_irc_line(inline_line text, block_id bigint, slot smallint)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE wire_line text;
BEGIN
  IF block_id IS NULL THEN RETURN inline_line; END IF;
  SELECT lines[slot] INTO wire_line FROM raw_irc_payload_blocks WHERE id = block_id;
  IF wire_line IS NULL THEN
    RAISE EXCEPTION 'Missing raw IRC payload at block %, position %', block_id, slot;
  END IF;
  RETURN wire_line;
END
$$;
--> statement-breakpoint
CREATE FUNCTION protect_raw_irc_payload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.payload_block_id IS NOT NULL THEN
      UPDATE raw_irc_payload_blocks SET lines[OLD.payload_position] = NULL WHERE id = OLD.payload_block_id;
    END IF;
    RETURN OLD;
  END IF;
  IF TG_ARGV[0] = 'locator' THEN
    IF OLD.payload_block_id IS NOT NULL AND NEW.raw_line IS NOT DISTINCT FROM OLD.raw_line AND
      (NEW.payload_block_id, NEW.payload_position) IS DISTINCT FROM (OLD.payload_block_id, OLD.payload_position) THEN
      RAISE EXCEPTION 'Cannot change an archived IRC locator without restoring its wire line';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.payload_block_id IS NOT NULL THEN
    -- Remove the archived copy in the same transaction as redaction or replacement.
    UPDATE raw_irc_payload_blocks SET lines[OLD.payload_position] = NULL WHERE id = OLD.payload_block_id;
    NEW.payload_block_id := NULL;
    NEW.payload_position := NULL;
    NEW.unrelayed_source := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER raw_irc_payload_guard BEFORE UPDATE OF raw_line OR DELETE
  ON raw_irc_messages FOR EACH ROW EXECUTE FUNCTION protect_raw_irc_payload();
--> statement-breakpoint
CREATE TRIGGER raw_irc_locator_guard BEFORE UPDATE OF payload_block_id, payload_position
  ON raw_irc_messages FOR EACH ROW EXECUTE FUNCTION protect_raw_irc_payload('locator');
--> statement-breakpoint
CREATE FUNCTION compact_raw_irc_batch(before_time timestamptz, batch_size integer DEFAULT 256)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE row_ids uuid[]; wire_lines text[]; new_block_id bigint; changed integer;
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 256 THEN RAISE EXCEPTION 'IRC batch size must be between 1 and 256'; END IF;
  SELECT array_agg(id ORDER BY received_at, id), array_agg(raw_line ORDER BY received_at, id)
    INTO row_ids, wire_lines
  FROM (
    SELECT id, raw_line, received_at FROM raw_irc_messages
    WHERE payload_block_id IS NULL AND raw_line <> '' AND received_at < before_time
    ORDER BY received_at, id LIMIT batch_size FOR UPDATE SKIP LOCKED
  ) batch;
  IF row_ids IS NULL THEN RETURN 0; END IF;
  INSERT INTO raw_irc_payload_blocks (lines) VALUES (wire_lines) RETURNING id INTO new_block_id;
  -- Verify the stored block once, before publishing any locator. Per-row validation
  -- would decompress the same block up to 256 times during every batch.
  IF (SELECT lines FROM raw_irc_payload_blocks WHERE id = new_block_id) IS DISTINCT FROM wire_lines THEN
    RAISE EXCEPTION 'Raw IRC compaction changed the wire lines';
  END IF;
  UPDATE raw_irc_messages r SET
    payload_block_id = new_block_id,
    payload_position = location.slot::smallint,
    unrelayed_source = r.raw_line LIKE '@%' AND split_part(r.raw_line, ' ', 1) !~ '(?:^@|;)source-room-id=[^;]+',
    raw_line = ''
  FROM unnest(row_ids) WITH ORDINALITY AS location(id, slot) WHERE r.id = location.id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> cardinality(row_ids) THEN RAISE EXCEPTION 'IRC compaction changed the row count'; END IF;
  RETURN changed;
END
$$;
