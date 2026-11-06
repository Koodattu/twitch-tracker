SET LOCAL lock_timeout='5s';
--> statement-breakpoint
ALTER TABLE chat_message_records ADD COLUMN unrelayed_source boolean;
--> statement-breakpoint
CREATE OR REPLACE VIEW chat_messages AS SELECT twitch_message_id,broadcaster_user_id,twitch_stream_id,chatter_user_id,chatter_login,
 source,sent_at,received_at,message_type,raw_text,badges,emotes,reply_parent_message_id,shared_chat_source_channel_id,
 deleted_at,cleared_at,raw_irc_message_id,raw_eventsub_event_id,
 unpack_record_time(record_times,received_at) AS created_at,
 coalesce(updated_at,unpack_record_time(record_times,received_at)) AS updated_at,unrelayed_source FROM chat_message_records;
--> statement-breakpoint
CREATE INDEX raw_chat_expiry_idx ON raw_irc_records(received_at)
 WHERE parsed_command='' AND processing_status='processed';
--> statement-breakpoint
CREATE FUNCTION expire_chat_wire_batch(cutoff timestamptz, batch_size integer)
RETURNS integer LANGUAGE plpgsql SET timezone='UTC' SET jit=off AS $$
DECLARE candidates uuid[]; removed integer;
BEGIN
 IF cutoff IS NULL OR cutoff>date_trunc('day',now(),'UTC')-interval '30 days' THEN
   RAISE EXCEPTION 'Thirty complete days of raw chat must be retained';
 END IF;
 IF batch_size IS NULL OR batch_size<1 OR batch_size>5000 THEN
   RAISE EXCEPTION 'Chat wire batch size must be between 1 and 5000';
 END IF;
 -- Coordinate with subject deletion, as membership expiry does.
 PERFORM id FROM community_map_state WHERE id='current' FOR SHARE;
 SELECT array_agg(id) INTO candidates FROM (
   SELECT r.id FROM raw_irc_records r
   WHERE r.parsed_command='' AND r.processing_status='processed' AND r.received_at<cutoff
     AND EXISTS(SELECT 1 FROM chat_message_records m WHERE m.raw_irc_message_id=r.id)
     AND NOT EXISTS(SELECT 1 FROM chat_message_records m WHERE m.raw_irc_message_id=r.id
       AND (m.raw_text IS NULL OR m.received_at>=cutoff OR m.source<>'' OR m.message_type<>''))
     AND NOT EXISTS(SELECT 1 FROM membership_events e WHERE e.raw_irc_message_id=r.id)
     AND NOT EXISTS(SELECT 1 FROM channel_events e WHERE e.raw_irc_message_id=r.id)
     AND NOT EXISTS(SELECT 1 FROM chat_room_state_events e WHERE e.raw_irc_message_id=r.id)
   ORDER BY r.received_at LIMIT batch_size FOR UPDATE OF r SKIP LOCKED
 ) batch;
 IF candidates IS NULL THEN RETURN 0; END IF;
 -- Preserve the exact source-classification fallback before detaching the wire.
 UPDATE chat_message_records m SET
   unrelayed_source=coalesce(m.unrelayed_source,r.unrelayed_source,
     r.raw_line like '@%' and split_part(r.raw_line,' ',1) !~ '(?:^@|;)source-room-id=[^;]+'),
   raw_irc_message_id=NULL
 FROM raw_irc_records r WHERE r.id=ANY(candidates) AND m.raw_irc_message_id=r.id;
 DELETE FROM raw_irc_records WHERE id=ANY(candidates);
 GET DIAGNOSTICS removed=ROW_COUNT;
 -- The existing statement trigger clears only deleted positions in mixed blocks.
 RETURN removed;
END $$;
