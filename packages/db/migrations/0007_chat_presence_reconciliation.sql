ALTER TABLE "chat_membership_events" ADD COLUMN "source" text DEFAULT 'irc_membership' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_membership_events" ADD COLUMN "confidence" integer DEFAULT 70 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_membership_events" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_membership_events_dedupe_key_idx" ON "chat_membership_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE TABLE "chat_presence_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcaster_user_id" text NOT NULL,
	"twitch_stream_id" text,
	"bot_account_id" uuid,
	"source" text NOT NULL,
	"confidence" integer DEFAULT 90 NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"chatter_count" integer DEFAULT 0 NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"request_status" text DEFAULT 'succeeded' NOT NULL,
	"latest_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_presence_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"broadcaster_user_id" text NOT NULL,
	"chatter_user_id" text,
	"chatter_login" text,
	"chatter_display_name" text,
	"twitch_stream_id" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"confidence" integer DEFAULT 90 NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_presence_snapshots" ADD CONSTRAINT "chat_presence_snapshots_broadcaster_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("broadcaster_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_presence_snapshots" ADD CONSTRAINT "chat_presence_snapshots_twitch_stream_id_stream_sessions_twitch_stream_id_fk" FOREIGN KEY ("twitch_stream_id") REFERENCES "public"."stream_sessions"("twitch_stream_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_presence_snapshots" ADD CONSTRAINT "chat_presence_snapshots_bot_account_id_bot_accounts_id_fk" FOREIGN KEY ("bot_account_id") REFERENCES "public"."bot_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_presence_observations" ADD CONSTRAINT "chat_presence_observations_snapshot_id_chat_presence_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."chat_presence_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_presence_observations" ADD CONSTRAINT "chat_presence_observations_broadcaster_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("broadcaster_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_presence_observations" ADD CONSTRAINT "chat_presence_observations_chatter_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("chatter_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_presence_observations" ADD CONSTRAINT "chat_presence_observations_twitch_stream_id_stream_sessions_twitch_stream_id_fk" FOREIGN KEY ("twitch_stream_id") REFERENCES "public"."stream_sessions"("twitch_stream_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_presence_snapshots_channel_sampled_idx" ON "chat_presence_snapshots" USING btree ("broadcaster_user_id","sampled_at");--> statement-breakpoint
CREATE INDEX "chat_presence_snapshots_stream_sampled_idx" ON "chat_presence_snapshots" USING btree ("twitch_stream_id","sampled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_presence_observations_dedupe_key_idx" ON "chat_presence_observations" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "chat_presence_observations_channel_observed_idx" ON "chat_presence_observations" USING btree ("broadcaster_user_id","observed_at");--> statement-breakpoint
CREATE INDEX "chat_presence_observations_chatter_observed_idx" ON "chat_presence_observations" USING btree ("chatter_user_id","observed_at");
