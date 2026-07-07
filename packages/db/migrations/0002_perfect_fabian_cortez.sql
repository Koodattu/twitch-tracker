CREATE TABLE "eventsub_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"twitch_subscription_id" text,
	"event_type" text NOT NULL,
	"event_version" text NOT NULL,
	"condition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"condition_key" text NOT NULL,
	"broadcaster_user_id" text,
	"transport_method" text DEFAULT 'webhook' NOT NULL,
	"callback_url" text NOT NULL,
	"status" text DEFAULT 'desired' NOT NULL,
	"cost" integer,
	"last_synced_at" timestamp with time zone,
	"latest_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eventsub_subscriptions" ADD CONSTRAINT "eventsub_subscriptions_broadcaster_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("broadcaster_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eventsub_subscriptions_twitch_subscription_idx" ON "eventsub_subscriptions" USING btree ("twitch_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eventsub_subscriptions_desired_identity_idx" ON "eventsub_subscriptions" USING btree ("event_type","event_version","condition_key","callback_url");--> statement-breakpoint
CREATE INDEX "eventsub_subscriptions_status_idx" ON "eventsub_subscriptions" USING btree ("status","updated_at");