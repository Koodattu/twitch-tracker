SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE membership_capture_windows (
 id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 context_id integer NOT NULL REFERENCES membership_event_contexts(id),
 bot_account_id uuid NOT NULL REFERENCES bot_accounts(id),
 connection_id uuid NOT NULL,
 started_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL,
 ended_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX membership_capture_open_idx ON membership_capture_windows(connection_id,context_id) WHERE ended_at IS NULL;
--> statement-breakpoint
ALTER TABLE membership_events ADD COLUMN capture_window_id integer REFERENCES membership_capture_windows(id);
--> statement-breakpoint
CREATE INDEX membership_events_capture_idx ON membership_events(capture_window_id) WHERE capture_window_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX membership_events_context_received_idx ON membership_events(context_id,received_at);
--> statement-breakpoint
CREATE TABLE membership_rollup_queue (
 context_id integer PRIMARY KEY REFERENCES membership_event_contexts(id),
 first_event_at timestamptz NOT NULL,
 last_event_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX membership_rollup_due_idx ON membership_rollup_queue(first_event_at,context_id);
--> statement-breakpoint
INSERT INTO membership_rollup_queue SELECT context_id,min(received_at),max(received_at) FROM membership_events GROUP BY context_id;
--> statement-breakpoint
CREATE FUNCTION queue_membership_rollup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO membership_rollup_queue VALUES(NEW.context_id,NEW.received_at,NEW.received_at)
 ON CONFLICT(context_id) DO UPDATE SET
 first_event_at=least(membership_rollup_queue.first_event_at,excluded.first_event_at),
 last_event_at=greatest(membership_rollup_queue.last_event_at,excluded.last_event_at);
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER membership_rollup_enqueue AFTER INSERT ON membership_events FOR EACH ROW EXECUTE FUNCTION queue_membership_rollup();
--> statement-breakpoint
CREATE TABLE membership_daily_summaries (
 context_id integer NOT NULL REFERENCES membership_event_contexts(id),
 subject_key text NOT NULL,
 day date NOT NULL,
 chatter_user_id text REFERENCES twitch_users(twitch_user_id),
 chatter_login text,
 join_count integer NOT NULL DEFAULT 0,
 part_count integer NOT NULL DEFAULT 0,
 matched_milliseconds bigint NOT NULL DEFAULT 0,
 estimated_milliseconds bigint NOT NULL DEFAULT 0,
 unmatched_join_count integer NOT NULL DEFAULT 0,
 unmatched_part_count integer NOT NULL DEFAULT 0,
 repeated_join_count integer NOT NULL DEFAULT 0,
 repeated_part_count integer NOT NULL DEFAULT 0,
 first_observed_at timestamptz,
 last_observed_at timestamptz,
 community_event_count integer NOT NULL DEFAULT 0,
 community_first_at timestamptz,
 community_last_at timestamptz,
 PRIMARY KEY(context_id,subject_key,day),
 CHECK(join_count>=0 AND part_count>=0 AND matched_milliseconds>=0 AND estimated_milliseconds>=0)
);
--> statement-breakpoint
CREATE INDEX membership_daily_user_day_idx ON membership_daily_summaries(chatter_user_id,day);
--> statement-breakpoint
CREATE INDEX membership_daily_login_idx ON membership_daily_summaries(chatter_login);
--> statement-breakpoint
CREATE INDEX membership_daily_day_idx ON membership_daily_summaries(day);
--> statement-breakpoint
-- Legacy JOIN/PART wire records remain in the separately retained raw archive.
-- Keep their erasure links when removing the detailed membership ledger.
CREATE TABLE membership_raw_evidence (
 raw_irc_message_id uuid NOT NULL REFERENCES raw_irc_records(id) ON DELETE CASCADE,
 chatter_user_id text,
 chatter_login text,
 UNIQUE NULLS NOT DISTINCT(raw_irc_message_id,chatter_user_id,chatter_login)
);
--> statement-breakpoint
CREATE INDEX membership_evidence_user_idx ON membership_raw_evidence(chatter_user_id);
--> statement-breakpoint
CREATE INDEX membership_evidence_login_idx ON membership_raw_evidence(chatter_login);
--> statement-breakpoint
CREATE FUNCTION record_membership_capture(bot uuid,connection uuid,channel text,stream text,observed timestamptz)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE result integer; coverage_started timestamptz;
BEGIN
 SELECT min(w.started_at) INTO coverage_started FROM membership_capture_windows w
 JOIN membership_event_contexts c ON c.id=w.context_id
 WHERE w.connection_id=connection AND c.broadcaster_user_id=channel AND w.ended_at IS NULL;
 INSERT INTO membership_capture_windows(context_id,bot_account_id,connection_id,started_at,last_seen_at)
 VALUES(get_membership_context(channel,stream),bot,connection,coalesce(coverage_started,observed),observed)
 ON CONFLICT(connection_id,context_id) WHERE ended_at IS NULL DO UPDATE SET last_seen_at=greatest(membership_capture_windows.last_seen_at,excluded.last_seen_at)
 RETURNING id INTO result;
 RETURN result;
END $$;
--> statement-breakpoint
CREATE FUNCTION insert_captured_membership_event(channel text,person text,login text,stream text,kind chat_membership_event_type,
 observed timestamptz,checked timestamptz,digest bytea,raw_id uuid,capture integer)
RETURNS SETOF chat_membership_events LANGUAGE plpgsql AS $$
DECLARE inserted chat_membership_events;
BEGIN
 FOR inserted IN SELECT * FROM insert_membership_event(channel,person,login,stream,kind,observed,checked,digest,raw_id) LOOP
   UPDATE membership_events SET capture_window_id=capture WHERE id=inserted.id;
   RETURN NEXT inserted;
 END LOOP;
END $$;
--> statement-breakpoint
-- One expired stream/context per transaction. A failure rolls back both totals
-- and deletion, so retries cannot double count. Active streams are never split.
CREATE FUNCTION rollup_expired_membership(cutoff timestamptz DEFAULT date_trunc('day',now(),'UTC')-interval '7 days')
RETURNS jsonb LANGUAGE plpgsql SET timezone='UTC' AS $$
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

 CREATE TEMP TABLE membership_rollup_input ON COMMIT DROP AS
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
