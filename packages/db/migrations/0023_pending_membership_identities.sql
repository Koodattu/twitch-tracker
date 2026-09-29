SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- Pending status belongs to identities after cohort resolution. Index both open
-- cohorts and historical immutable identities, excluding already checked users.
CREATE INDEX membership_identity_unchecked_idx ON membership_event_identities(id)
 WHERE chatter_user_id IS NULL AND resolved_at IS NULL AND chatter_login IS NOT NULL;
--> statement-breakpoint
DROP INDEX membership_events_unchecked_idx;
--> statement-breakpoint
ALTER TABLE membership_event_identities SET (
 autovacuum_vacuum_scale_factor = 0.02,
 autovacuum_analyze_scale_factor = 0.02
);
--> statement-breakpoint
ANALYZE membership_event_identities;
