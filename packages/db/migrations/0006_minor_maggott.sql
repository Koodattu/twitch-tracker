CREATE TYPE "public"."privacy_request_status" AS ENUM('pending', 'completed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."privacy_request_type" AS ENUM('public_profile_opt_out', 'tracking_opt_out', 'data_deletion');--> statement-breakpoint
CREATE TABLE "privacy_request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"privacy_request_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_app_user_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_type" "privacy_request_type" NOT NULL,
	"status" "privacy_request_status" DEFAULT 'pending' NOT NULL,
	"subject_twitch_user_id" text NOT NULL,
	"requested_by_app_user_id" uuid,
	"reviewed_by_app_user_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"latest_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subject_privacy_states" (
	"twitch_user_id" text PRIMARY KEY NOT NULL,
	"public_profile_hidden" boolean DEFAULT false NOT NULL,
	"tracking_opted_out" boolean DEFAULT false NOT NULL,
	"raw_data_redacted_at" timestamp with time zone,
	"data_deleted_at" timestamp with time zone,
	"latest_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "privacy_request_events" ADD CONSTRAINT "privacy_request_events_privacy_request_id_privacy_requests_id_fk" FOREIGN KEY ("privacy_request_id") REFERENCES "public"."privacy_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_request_events" ADD CONSTRAINT "privacy_request_events_actor_app_user_id_app_users_id_fk" FOREIGN KEY ("actor_app_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_subject_twitch_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("subject_twitch_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_requested_by_app_user_id_app_users_id_fk" FOREIGN KEY ("requested_by_app_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_reviewed_by_app_user_id_app_users_id_fk" FOREIGN KEY ("reviewed_by_app_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_privacy_states" ADD CONSTRAINT "subject_privacy_states_twitch_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("twitch_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subject_privacy_states" ADD CONSTRAINT "subject_privacy_states_latest_request_id_privacy_requests_id_fk" FOREIGN KEY ("latest_request_id") REFERENCES "public"."privacy_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "privacy_request_events_request_occurred_idx" ON "privacy_request_events" USING btree ("privacy_request_id","occurred_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_subject_requested_idx" ON "privacy_requests" USING btree ("subject_twitch_user_id","requested_at");--> statement-breakpoint
CREATE INDEX "privacy_requests_status_requested_idx" ON "privacy_requests" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "subject_privacy_states_public_hidden_idx" ON "subject_privacy_states" USING btree ("public_profile_hidden");--> statement-breakpoint
CREATE INDEX "subject_privacy_states_tracking_opted_out_idx" ON "subject_privacy_states" USING btree ("tracking_opted_out");