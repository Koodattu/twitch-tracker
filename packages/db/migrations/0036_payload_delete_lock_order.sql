SET LOCAL lock_timeout='5s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION clear_deleted_irc_payloads() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Overlapping deletion batches must acquire archive blocks in the same order.
 -- UPDATE ... FROM may otherwise choose a different order for each query plan.
 PERFORM b.id FROM raw_irc_payload_blocks b
 WHERE b.id IN (SELECT payload_block_id FROM deleted_irc WHERE payload_block_id IS NOT NULL)
 ORDER BY b.id FOR UPDATE OF b;
 UPDATE raw_irc_payload_blocks b SET lines=(
   SELECT array_agg(CASE WHEN slot=ANY(g.positions) THEN NULL ELSE line END ORDER BY slot)
   FROM unnest(b.lines) WITH ORDINALITY AS p(line,slot)
 ) FROM (SELECT payload_block_id,array_agg(payload_position) AS positions FROM deleted_irc
   WHERE payload_block_id IS NOT NULL GROUP BY payload_block_id) g WHERE b.id=g.payload_block_id;
 RETURN NULL;
END $$;
