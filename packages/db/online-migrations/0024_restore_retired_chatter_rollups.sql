-- Stop writers and restore the pre-0022 chatter_channel_activity_buckets dump
-- first. This reverses 0022/0023 only; retain the matching application images.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF (SELECT max(created_at) FROM drizzle.__drizzle_migrations)<>1790658001000 THEN
  RAISE EXCEPTION 'Expected 0023 to be the latest migration';
 END IF;
 IF to_regclass('public.chatter_channel_activity_buckets') IS NULL THEN
  RAISE EXCEPTION 'Restore the retired table from the pre-migration backup first';
 END IF;
END $$;
-- A later rollback must not restore summaries for subjects deleted since backup.
DELETE FROM chatter_channel_activity_buckets b USING subject_privacy_states p
 WHERE b.chatter_user_id=p.twitch_user_id AND p.data_deleted_at IS NOT NULL;
CREATE INDEX membership_events_unchecked_idx ON membership_events(received_at) WHERE identity_time_kind=0;
DROP INDEX membership_identity_unchecked_idx;
ALTER TABLE membership_event_identities RESET(autovacuum_vacuum_scale_factor,autovacuum_analyze_scale_factor);
DELETE FROM drizzle.__drizzle_migrations WHERE created_at IN(1790658000000,1790658001000);
COMMIT;
