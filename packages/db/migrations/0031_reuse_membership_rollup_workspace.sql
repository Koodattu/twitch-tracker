-- Reuse a connection-local staging relation so PostgreSQL can cache batch plans.
CREATE OR REPLACE FUNCTION rollup_expired_membership(cutoff timestamptz DEFAULT date_trunc('day',now(),'UTC')-interval '7 days')
RETURNS jsonb LANGUAGE plpgsql SET timezone='UTC' SET jit=off AS $$
DECLARE target integer; input_count bigint; removed bigint; summary_count bigint;
BEGIN
 IF cutoff>date_trunc('day',now(),'UTC')-interval '7 days' THEN RAISE EXCEPTION 'Seven complete days of raw membership must be retained'; END IF;
 -- Coordinate with the existing privacy completion lock.
 PERFORM id FROM community_map_state WHERE id='current' FOR SHARE;
 SELECT q.context_id INTO target FROM membership_rollup_queue q
 JOIN membership_event_contexts c ON c.id=q.context_id
 LEFT JOIN stream_sessions s ON s.twitch_stream_id=c.twitch_stream_id
 WHERE q.first_event_at<cutoff AND (c.twitch_stream_id IS NULL OR (s.ended_at<cutoff AND q.last_event_at<cutoff))
 ORDER BY q.first_event_at,q.context_id LIMIT 1 FOR UPDATE OF q SKIP LOCKED;
 IF target IS NULL THEN RETURN jsonb_build_object('context',NULL,'events',0,'summaries',0); END IF;

 IF to_regclass('pg_temp.membership_rollup_input') IS NULL THEN
 CREATE TEMP TABLE membership_rollup_input ON COMMIT DELETE ROWS AS
 SELECT e.*,i.chatter_user_id,i.chatter_login,
   coalesce('id:'||i.chatter_user_id,'login:'||lower(i.chatter_login),'anonymous') AS subject_key,
   s.started_at AS stream_start,s.ended_at AS stream_end,
   greatest(s.started_at,w.started_at) AS coverage_start,
   least(s.ended_at,w.ended_at) AS coverage_end,
   s.is_finnish_eligible AND e.source_override IS NULL AND e.received_at>=s.started_at
     AND e.received_at<=s.ended_at AS community_eligible
 FROM membership_events e JOIN membership_event_identities i ON i.id=e.identity_id
 JOIN membership_event_contexts c ON c.id=e.context_id
 LEFT JOIN stream_sessions s ON s.twitch_stream_id=c.twitch_stream_id AND s.broadcaster_user_id=c.broadcaster_user_id
 LEFT JOIN membership_capture_windows w ON w.id=e.capture_window_id
 WHERE e.context_id=target AND e.received_at<cutoff WITH NO DATA;
 END IF;
 TRUNCATE membership_rollup_input;
 INSERT INTO membership_rollup_input
 SELECT e.*,i.chatter_user_id,i.chatter_login,
   coalesce('id:'||i.chatter_user_id,'login:'||lower(i.chatter_login),'anonymous') AS subject_key,
   s.started_at AS stream_start,s.ended_at AS stream_end,
   greatest(s.started_at,w.started_at) AS coverage_start,
   least(s.ended_at,w.ended_at) AS coverage_end,
   s.is_finnish_eligible AND e.source_override IS NULL AND e.received_at>=s.started_at
     AND e.received_at<=s.ended_at AS community_eligible
 FROM membership_events e JOIN membership_event_identities i ON i.id=e.identity_id
 JOIN membership_event_contexts c ON c.id=e.context_id
 LEFT JOIN stream_sessions s ON s.twitch_stream_id=c.twitch_stream_id AND s.broadcaster_user_id=c.broadcaster_user_id
 LEFT JOIN membership_capture_windows w ON w.id=e.capture_window_id
 WHERE e.context_id=target AND e.received_at<cutoff;
 SELECT count(*) INTO input_count FROM membership_rollup_input;

 INSERT INTO membership_raw_evidence
 SELECT DISTINCT raw_irc_message_id,chatter_user_id,chatter_login FROM membership_rollup_input WHERE raw_irc_message_id IS NOT NULL
 ON CONFLICT DO NOTHING;

 WITH ordered AS MATERIALIZED (
   SELECT *,lag(is_join) OVER seq AS previous_join,lead(is_join) OVER seq AS next_join,
     lead(received_at) OVER seq AS next_at
   FROM membership_rollup_input
   WINDOW seq AS (PARTITION BY subject_key,capture_window_id ORDER BY received_at,id)
 ), intervals AS (
   SELECT subject_key,chatter_user_id,chatter_login,
     CASE WHEN is_join THEN greatest(received_at,coverage_start) ELSE coverage_start END AS start_at,
     CASE WHEN is_join THEN least(coalesce(next_at,coverage_end),coverage_end) ELSE least(received_at,coverage_end) END AS end_at,
     coalesce(is_join AND next_join=false AND capture_window_id IS NOT NULL
       AND received_at>=coverage_start AND next_at<=coverage_end,false) AS matched
   FROM ordered WHERE stream_start IS NOT NULL AND stream_end IS NOT NULL AND subject_key<>'anonymous'
     AND (is_join OR previous_join IS NULL)
     AND NOT EXISTS(SELECT 1 FROM membership_daily_summaries WHERE context_id=target)
 ), ranges AS (
   SELECT subject_key,range_agg(tstzrange(start_at,end_at,'[)')) FILTER(WHERE matched) AS matched,
     range_agg(tstzrange(start_at,end_at,'[)')) FILTER(WHERE NOT matched) AS estimated
   FROM intervals WHERE end_at>start_at GROUP BY subject_key
 ), disjoint AS (
   SELECT subject_key,true AS matched,unnest(coalesce(matched,'{}'::tstzmultirange)) AS span FROM ranges
   UNION ALL
   SELECT subject_key,false,unnest(coalesce(estimated,'{}'::tstzmultirange)-coalesce(matched,'{}'::tstzmultirange)) FROM ranges
 ), duration_days AS (
   SELECT subject_key,(d AT TIME ZONE 'UTC')::date AS day,
     sum(round(extract(epoch FROM (least(upper(span),d+interval '1 day')-greatest(lower(span),d)))*1000)) FILTER(WHERE matched)::bigint AS matched_ms,
     sum(round(extract(epoch FROM (least(upper(span),d+interval '1 day')-greatest(lower(span),d)))*1000)) FILTER(WHERE NOT matched)::bigint AS estimated_ms
   FROM disjoint CROSS JOIN LATERAL generate_series(date_trunc('day',lower(span),'UTC'),date_trunc('day',upper(span)-interval '1 microsecond','UTC'),interval '1 day') d
   GROUP BY subject_key,d
 ), event_days AS (
   SELECT subject_key,(received_at AT TIME ZONE 'UTC')::date AS day,
     count(*) FILTER(WHERE is_join)::int AS joins,count(*) FILTER(WHERE NOT is_join)::int AS parts,
     count(*) FILTER(WHERE is_join AND next_join IS DISTINCT FROM false)::int AS unmatched_joins,
     count(*) FILTER(WHERE NOT is_join AND previous_join IS DISTINCT FROM true)::int AS unmatched_parts,
     count(*) FILTER(WHERE is_join AND previous_join=true)::int AS repeated_joins,
     count(*) FILTER(WHERE NOT is_join AND previous_join=false)::int AS repeated_parts,
     min(received_at) AS first_at,max(received_at) AS last_at,
     count(*) FILTER(WHERE community_eligible)::int AS community_count,
     min(received_at) FILTER(WHERE community_eligible) AS community_first,
     max(received_at) FILTER(WHERE community_eligible) AS community_last
   FROM ordered GROUP BY subject_key,day
 ), subjects AS (
   SELECT subject_key,min(chatter_user_id) AS person,min(chatter_login) AS login FROM ordered GROUP BY subject_key
 )
 INSERT INTO membership_daily_summaries
 SELECT target,coalesce(e.subject_key,d.subject_key),coalesce(e.day,d.day),s.person,s.login,
   coalesce(e.joins,0),coalesce(e.parts,0),coalesce(d.matched_ms,0),coalesce(d.estimated_ms,0),
   coalesce(e.unmatched_joins,0),coalesce(e.unmatched_parts,0),coalesce(e.repeated_joins,0),coalesce(e.repeated_parts,0),
   e.first_at,e.last_at,coalesce(e.community_count,0),e.community_first,e.community_last
 FROM event_days e FULL JOIN duration_days d USING(subject_key,day)
 JOIN subjects s ON s.subject_key=coalesce(e.subject_key,d.subject_key)
 ON CONFLICT(context_id,subject_key,day) DO UPDATE SET
   join_count=membership_daily_summaries.join_count+excluded.join_count,
   part_count=membership_daily_summaries.part_count+excluded.part_count,
   matched_milliseconds=membership_daily_summaries.matched_milliseconds+excluded.matched_milliseconds,
   estimated_milliseconds=membership_daily_summaries.estimated_milliseconds+excluded.estimated_milliseconds,
   unmatched_join_count=membership_daily_summaries.unmatched_join_count+excluded.unmatched_join_count,
   unmatched_part_count=membership_daily_summaries.unmatched_part_count+excluded.unmatched_part_count,
   repeated_join_count=membership_daily_summaries.repeated_join_count+excluded.repeated_join_count,
   repeated_part_count=membership_daily_summaries.repeated_part_count+excluded.repeated_part_count,
   first_observed_at=least(membership_daily_summaries.first_observed_at,excluded.first_observed_at),
   last_observed_at=greatest(membership_daily_summaries.last_observed_at,excluded.last_observed_at),
   community_event_count=membership_daily_summaries.community_event_count+excluded.community_event_count,
   community_first_at=least(membership_daily_summaries.community_first_at,excluded.community_first_at),
   community_last_at=greatest(membership_daily_summaries.community_last_at,excluded.community_last_at);
 GET DIAGNOSTICS summary_count=ROW_COUNT;

 DELETE FROM membership_events e USING membership_rollup_input i WHERE e.id=i.id;
 GET DIAGNOSTICS removed=ROW_COUNT;
 IF removed<>input_count THEN RAISE EXCEPTION 'Membership rollup count changed'; END IF;
 DELETE FROM membership_event_identities i WHERE i.id IN (SELECT identity_id FROM membership_rollup_input)
   AND NOT EXISTS(SELECT 1 FROM membership_events e WHERE e.identity_id=i.id);
 DELETE FROM membership_capture_windows w WHERE w.context_id=target
   AND NOT EXISTS(SELECT 1 FROM membership_events e WHERE e.capture_window_id=w.id);
 DELETE FROM membership_rollup_queue WHERE context_id=target;
 INSERT INTO membership_rollup_queue SELECT target,min(received_at),max(received_at) FROM membership_events WHERE context_id=target HAVING count(*)>0;
 RETURN jsonb_build_object('context',target,'events',removed,'summaries',summary_count);
END $$;
