ALTER TABLE "oauth_accounts" ADD COLUMN "last_validated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "refresh_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD COLUMN "latest_error" text;