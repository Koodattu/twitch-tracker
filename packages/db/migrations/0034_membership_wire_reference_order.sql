-- Check detailed membership first: during backfill most old wire rows still
-- have that reference. Avoid probing three unrelated indexes for those rows.
CREATE OR REPLACE FUNCTION expire_membership_wire_batch(cutoff timestamptz, batch_size integer)
RETURNS integer LANGUAGE plpgsql SET timezone='UTC' SET jit=off AS $$
DECLARE removed integer;
BEGIN
 IF cutoff>date_trunc('day',now(),'UTC')-interval '7 days' THEN RAISE EXCEPTION 'Seven complete days of raw membership must be retained'; END IF;
 IF batch_size<1 OR batch_size>5000 OR batch_size IS NULL THEN RAISE EXCEPTION 'Wire batch size must be between 1 and 5000'; END IF;
 PERFORM id FROM community_map_state WHERE id='current' FOR SHARE;
 WITH candidates AS MATERIALIZED (
   SELECT r.id FROM raw_irc_records r
   WHERE r.parsed_command IN ('!JOIN','!PART') AND r.received_at<cutoff
     AND CASE WHEN EXISTS(SELECT 1 FROM membership_events e WHERE e.raw_irc_message_id=r.id) THEN false ELSE
     NOT EXISTS(SELECT 1 FROM chat_message_records m WHERE m.raw_irc_message_id=r.id)
     AND NOT EXISTS(SELECT 1 FROM channel_events e WHERE e.raw_irc_message_id=r.id)
     AND NOT EXISTS(SELECT 1 FROM chat_room_state_events e WHERE e.raw_irc_message_id=r.id) END
   ORDER BY r.received_at,r.id LIMIT batch_size FOR UPDATE OF r SKIP LOCKED
 ) DELETE FROM raw_irc_records r USING candidates c WHERE r.id=c.id;
 GET DIAGNOSTICS removed=ROW_COUNT;
 RETURN removed;
END $$;
