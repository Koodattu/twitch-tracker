SET LOCAL lock_timeout='5s';
--> statement-breakpoint
-- Deletion must check references without scanning the full child tables.
CREATE INDEX channel_events_raw_idx ON channel_events(raw_irc_message_id) WHERE raw_irc_message_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX chat_records_raw_idx ON chat_message_records(raw_irc_message_id) WHERE raw_irc_message_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX room_state_raw_idx ON chat_room_state_events(raw_irc_message_id) WHERE raw_irc_message_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX membership_events_raw_idx ON membership_events(raw_irc_message_id) WHERE raw_irc_message_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX raw_membership_expiry_idx ON raw_irc_records(received_at,id) WHERE parsed_command IN ('!JOIN','!PART');
--> statement-breakpoint
-- Clear archived wire slots once per affected block, preserving every other slot.
-- The former row trigger rewrote the same compressed array for every deletion.
CREATE FUNCTION clear_deleted_irc_payloads() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE raw_irc_payload_blocks b SET lines=(
   SELECT array_agg(CASE WHEN slot=ANY(g.positions) THEN NULL ELSE line END ORDER BY slot)
   FROM unnest(b.lines) WITH ORDINALITY AS p(line,slot)
 ) FROM (SELECT payload_block_id,array_agg(payload_position) AS positions FROM deleted_irc
   WHERE payload_block_id IS NOT NULL GROUP BY payload_block_id) g WHERE b.id=g.payload_block_id;
 RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER raw_irc_payload_guard ON raw_irc_records;
--> statement-breakpoint
CREATE TRIGGER raw_irc_payload_guard BEFORE UPDATE OF raw_line ON raw_irc_records
 FOR EACH ROW EXECUTE FUNCTION protect_raw_irc_payload();
--> statement-breakpoint
CREATE TRIGGER raw_irc_deleted_payloads AFTER DELETE ON raw_irc_records
 REFERENCING OLD TABLE AS deleted_irc FOR EACH STATEMENT EXECUTE FUNCTION clear_deleted_irc_payloads();
--> statement-breakpoint
CREATE FUNCTION expire_membership_wire_batch(cutoff timestamptz, batch_size integer)
RETURNS integer LANGUAGE plpgsql SET timezone='UTC' SET jit=off AS $$
DECLARE removed integer;
BEGIN
 IF cutoff>date_trunc('day',now(),'UTC')-interval '7 days' THEN RAISE EXCEPTION 'Seven complete days of raw membership must be retained'; END IF;
 IF batch_size<1 OR batch_size>5000 OR batch_size IS NULL THEN RAISE EXCEPTION 'Wire batch size must be between 1 and 5000'; END IF;
 PERFORM id FROM community_map_state WHERE id='current' FOR SHARE;
 WITH candidates AS MATERIALIZED (
   SELECT r.id FROM raw_irc_records r
   WHERE r.parsed_command IN ('!JOIN','!PART') AND r.received_at<cutoff
     AND NOT EXISTS(SELECT 1 FROM membership_events e WHERE e.raw_irc_message_id=r.id)
     AND NOT EXISTS(SELECT 1 FROM chat_message_records m WHERE m.raw_irc_message_id=r.id)
     AND NOT EXISTS(SELECT 1 FROM channel_events e WHERE e.raw_irc_message_id=r.id)
     AND NOT EXISTS(SELECT 1 FROM chat_room_state_events e WHERE e.raw_irc_message_id=r.id)
   ORDER BY r.received_at,r.id LIMIT batch_size FOR UPDATE OF r SKIP LOCKED
 ) DELETE FROM raw_irc_records r USING candidates c WHERE r.id=c.id;
 GET DIAGNOSTICS removed=ROW_COUNT;
 RETURN removed;
END $$;
