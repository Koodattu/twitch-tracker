ALTER TABLE chat_membership_events ADD COLUMN identity_checked_at timestamptz;
--> statement-breakpoint
CREATE INDEX chat_membership_events_unresolved_idx ON chat_membership_events (received_at)
WHERE chatter_user_id IS NULL AND identity_checked_at IS NULL AND chatter_login IS NOT NULL;
