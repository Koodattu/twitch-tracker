\set ON_ERROR_STOP on
\pset pager off
\timing on

BEGIN;
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '30s';

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TEMP TABLE compaction_baseline AS
SELECT
  (SELECT count(*) FROM raw_irc_messages) AS raw_irc_rows,
  (SELECT count(*) FROM stream_snapshots) AS snapshot_rows,
  (SELECT count(*) FROM chat_membership_events) AS membership_rows;

DO $validation$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM raw_irc_messages
    WHERE tags <> '{}'::jsonb
      AND raw_line NOT LIKE '@%'
  ) THEN
    RAISE EXCEPTION 'Cannot compact IRC tags: a tagged row has no wire-format tag prefix.';
  END IF;
END
$validation$;

UPDATE raw_irc_messages
SET tags = '{}'::jsonb
WHERE tags <> '{}'::jsonb;

CREATE TEMP TABLE redundant_snapshot_metadata_ids (
  id uuid PRIMARY KEY
) ON COMMIT PRESERVE ROWS;

INSERT INTO redundant_snapshot_metadata_ids (id)
SELECT id
FROM (
  SELECT
    id,
    title,
    category_id,
    category_name,
    language,
    tags,
    thumbnail_url,
    lag(id) OVER stream_metadata_order AS previous_id,
    lag(title) OVER stream_metadata_order AS previous_title,
    lag(category_id) OVER stream_metadata_order AS previous_category_id,
    lag(category_name) OVER stream_metadata_order AS previous_category_name,
    lag(language) OVER stream_metadata_order AS previous_language,
    lag(tags) OVER stream_metadata_order AS previous_tags,
    lag(thumbnail_url) OVER stream_metadata_order AS previous_thumbnail_url
  FROM stream_snapshots
  WHERE title IS NOT NULL
  WINDOW stream_metadata_order AS (
    PARTITION BY twitch_stream_id
    ORDER BY observed_at, id
  )
) metadata
WHERE previous_id IS NOT NULL
  AND title IS NOT DISTINCT FROM previous_title
  AND category_id IS NOT DISTINCT FROM previous_category_id
  AND category_name IS NOT DISTINCT FROM previous_category_name
  AND language IS NOT DISTINCT FROM previous_language
  AND tags IS NOT DISTINCT FROM previous_tags
  AND thumbnail_url IS NOT DISTINCT FROM previous_thumbnail_url;

UPDATE stream_snapshots snapshot
SET title = NULL,
    category_id = NULL,
    category_name = NULL,
    language = NULL,
    tags = '[]'::jsonb,
    thumbnail_url = NULL
FROM redundant_snapshot_metadata_ids redundant
WHERE snapshot.id = redundant.id;

CREATE OR REPLACE FUNCTION pg_temp.membership_dedupe_key(
  broadcaster_user_id text,
  twitch_stream_id text,
  event_type text,
  chatter_login text,
  event_at timestamptz
) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  SELECT translate(
    rtrim(
      encode(
        digest(
          convert_to(
            'irc_membership:'
              || broadcaster_user_id
              || ':' || coalesce(twitch_stream_id, 'no-stream')
              || ':' || event_type
              || ':' || coalesce(chatter_login, 'unknown')
              || ':' || to_char(
                date_trunc('second', event_at) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ),
            'UTF8'
          ),
          'sha256'
        ),
        'base64'
      ),
      '='
    ),
    '+/',
    '-_'
  )
$function$;

DO $validation$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM chat_membership_events
    WHERE length(dedupe_key) = 43
      AND dedupe_key <> pg_temp.membership_dedupe_key(
        broadcaster_user_id,
        twitch_stream_id,
        event_type::text,
        chatter_login,
        event_at
      )
  ) THEN
    RAISE EXCEPTION 'Cannot compact membership keys: SQL and application hashes differ.';
  END IF;
END
$validation$;

CREATE TEMP TABLE membership_dedupe_rewrite (
  id uuid PRIMARY KEY,
  new_key text NOT NULL UNIQUE CHECK (length(new_key) = 43)
) ON COMMIT PRESERVE ROWS;

INSERT INTO membership_dedupe_rewrite (id, new_key)
SELECT
  id,
  pg_temp.membership_dedupe_key(
    broadcaster_user_id,
    twitch_stream_id,
    event_type::text,
    chatter_login,
    event_at
  )
FROM chat_membership_events
WHERE length(dedupe_key) <> 43;

DO $validation$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM membership_dedupe_rewrite rewrite
    JOIN chat_membership_events existing
      ON existing.dedupe_key = rewrite.new_key
     AND existing.id <> rewrite.id
  ) THEN
    RAISE EXCEPTION 'Cannot compact membership keys: a rewritten key collides with an existing row.';
  END IF;
END
$validation$;

UPDATE chat_membership_events membership
SET dedupe_key = rewrite.new_key
FROM membership_dedupe_rewrite rewrite
WHERE membership.id = rewrite.id;

DO $validation$
DECLARE
  baseline compaction_baseline%ROWTYPE;
BEGIN
  SELECT * INTO STRICT baseline FROM compaction_baseline;

  IF (SELECT count(*) FROM raw_irc_messages) <> baseline.raw_irc_rows
    OR (SELECT count(*) FROM stream_snapshots) <> baseline.snapshot_rows
    OR (SELECT count(*) FROM chat_membership_events) <> baseline.membership_rows
  THEN
    RAISE EXCEPTION 'Compaction changed a protected row count.';
  END IF;

  IF EXISTS (SELECT 1 FROM raw_irc_messages WHERE tags <> '{}'::jsonb) THEN
    RAISE EXCEPTION 'IRC tag compaction is incomplete.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM chat_membership_events
    WHERE dedupe_key IS NULL OR length(dedupe_key) <> 43
  ) THEN
    RAISE EXCEPTION 'Membership dedupe compaction is incomplete.';
  END IF;
END
$validation$;

SELECT
  (SELECT raw_irc_rows FROM compaction_baseline) AS raw_irc_rows_preserved,
  (SELECT snapshot_rows FROM compaction_baseline) AS snapshot_rows_preserved,
  (SELECT membership_rows FROM compaction_baseline) AS membership_rows_preserved,
  (SELECT count(*) FROM redundant_snapshot_metadata_ids) AS snapshot_metadata_copies_removed,
  (SELECT count(*) FROM membership_dedupe_rewrite) AS membership_keys_rewritten;

COMMIT;

VACUUM (FULL, ANALYZE) raw_irc_messages;
VACUUM (FULL, ANALYZE) stream_snapshots;
VACUUM (FULL, ANALYZE) chat_membership_events;

SELECT relname AS table_name,
       pg_total_relation_size(relid) AS total_bytes,
       pg_relation_size(relid) AS heap_bytes,
       pg_indexes_size(relid) AS index_bytes,
       n_live_tup AS estimated_live_rows,
       n_dead_tup AS estimated_dead_rows
FROM pg_stat_user_tables
WHERE relname IN (
  'raw_irc_messages',
  'stream_snapshots',
  'chat_membership_events'
)
ORDER BY pg_total_relation_size(relid) DESC;
