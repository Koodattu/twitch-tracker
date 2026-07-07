CREATE TYPE "public"."app_mode" AS ENUM('local', 'private_mvp', 'production');--> statement-breakpoint
CREATE TYPE "public"."assignment_status" AS ENUM('desired', 'joining', 'joined', 'leaving', 'left', 'failed');--> statement-breakpoint
CREATE TYPE "public"."chat_membership_event_type" AS ENUM('join', 'part');--> statement-breakpoint
CREATE TYPE "public"."ingestion_run_status" AS ENUM('running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."raw_processing_status" AS ENUM('pending', 'processed', 'failed', 'ignored');--> statement-breakpoint
CREATE TABLE "admin_users" (
	"twitch_user_id" text PRIMARY KEY NOT NULL,
	"granted_by" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"twitch_user_id" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_account_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_account_id" uuid NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"encrypted_access_token" text,
	"encrypted_refresh_token" text,
	"expires_at" timestamp with time zone,
	"last_validated_at" timestamp with time zone,
	"refresh_status" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"twitch_user_id" text,
	"login" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_joined_rooms" integer DEFAULT 100 NOT NULL,
	"join_rate_per_10_seconds" integer DEFAULT 20 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_daily_stats" (
	"broadcaster_user_id" text NOT NULL,
	"day" text NOT NULL,
	"stream_count" integer DEFAULT 0 NOT NULL,
	"live_seconds" integer DEFAULT 0 NOT NULL,
	"viewer_count_max" integer,
	"viewer_count_avg" integer,
	"message_count" integer DEFAULT 0 NOT NULL,
	"aggregate_engagement" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_daily_stats_broadcaster_user_id_day_pk" PRIMARY KEY("broadcaster_user_id","day")
);
--> statement-breakpoint
CREATE TABLE "channel_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"broadcaster_user_id" text,
	"twitch_stream_id" text,
	"actor_user_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"source_event_id" text,
	"raw_eventsub_event_id" uuid,
	"raw_irc_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"twitch_user_id" text PRIMARY KEY NOT NULL,
	"has_been_seen_finnish" boolean DEFAULT false NOT NULL,
	"first_seen_finnish_at" timestamp with time zone,
	"last_seen_finnish_at" timestamp with time zone,
	"is_manually_pinned" boolean DEFAULT false NOT NULL,
	"is_opted_in" boolean DEFAULT false NOT NULL,
	"is_known_moderator" boolean DEFAULT false NOT NULL,
	"tracking_priority" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_assignment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_assignment_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"reason" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_account_id" uuid NOT NULL,
	"broadcaster_user_id" text NOT NULL,
	"twitch_stream_id" text,
	"status" "assignment_status" DEFAULT 'desired' NOT NULL,
	"priority_score" integer DEFAULT 0 NOT NULL,
	"join_method" text DEFAULT 'irc' NOT NULL,
	"reason" text NOT NULL,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"last_membership_event_at" timestamp with time zone,
	"latest_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_membership_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcaster_user_id" text NOT NULL,
	"chatter_user_id" text,
	"chatter_login" text,
	"twitch_stream_id" text,
	"event_type" "chat_membership_event_type" NOT NULL,
	"event_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"irc_connection_id" uuid,
	"raw_irc_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"twitch_message_id" text PRIMARY KEY NOT NULL,
	"broadcaster_user_id" text NOT NULL,
	"twitch_stream_id" text,
	"chatter_user_id" text,
	"chatter_login" text,
	"source" text DEFAULT 'irc' NOT NULL,
	"sent_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message_type" text DEFAULT 'privmsg' NOT NULL,
	"raw_text" text,
	"badges" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"emotes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reply_parent_message_id" text,
	"shared_chat_source_channel_id" text,
	"deleted_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"raw_irc_message_id" uuid,
	"raw_eventsub_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_room_state_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcaster_user_id" text,
	"bot_account_id" uuid,
	"state_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_irc_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chatter_channel_activity_buckets" (
	"chatter_user_id" text NOT NULL,
	"broadcaster_user_id" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"bucket_minutes" integer NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"first_activity_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"active_minutes" integer DEFAULT 0 NOT NULL,
	"join_count" integer DEFAULT 0 NOT NULL,
	"part_count" integer DEFAULT 0 NOT NULL,
	"emote_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"badge_observations" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chatter_channel_activity_buckets_chatter_user_id_broadcaster_user_id_bucket_start_bucket_minutes_pk" PRIMARY KEY("chatter_user_id","broadcaster_user_id","bucket_start","bucket_minutes")
);
--> statement-breakpoint
CREATE TABLE "chatter_daily_stats" (
	"chatter_user_id" text NOT NULL,
	"day" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"channels_active" integer DEFAULT 0 NOT NULL,
	"active_minutes" integer DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chatter_daily_stats_chatter_user_id_day_pk" PRIMARY KEY("chatter_user_id","day")
);
--> statement-breakpoint
CREATE TABLE "event_processing_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_source" text NOT NULL,
	"raw_id" uuid NOT NULL,
	"handler_name" text NOT NULL,
	"error_class" text NOT NULL,
	"error_message" text NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_type" text NOT NULL,
	"status" "ingestion_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"items_requested" integer DEFAULT 0 NOT NULL,
	"items_inserted" integer DEFAULT 0 NOT NULL,
	"items_updated" integer DEFAULT 0 NOT NULL,
	"items_skipped" integer DEFAULT 0 NOT NULL,
	"error_class" text,
	"error_message" text,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "irc_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_account_id" uuid NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"connected_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"last_ping_at" timestamp with time zone,
	"last_pong_at" timestamp with time zone,
	"reconnect_count" integer DEFAULT 0 NOT NULL,
	"latest_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_locks" (
	"name" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"locked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_user_id" uuid NOT NULL,
	"provider" text DEFAULT 'twitch' NOT NULL,
	"provider_user_id" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"encrypted_access_token" text,
	"encrypted_refresh_token" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_broadcaster_user_id" text,
	"target_broadcaster_user_id" text,
	"viewer_count" integer,
	"occurred_at" timestamp with time zone NOT NULL,
	"source_stream_id" text,
	"target_stream_id" text,
	"raw_eventsub_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"endpoint" text NOT NULL,
	"bot_account_id" uuid,
	"limit" integer,
	"remaining" integer,
	"reset_at" timestamp with time zone,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_eventsub_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"twitch_message_id" text,
	"twitch_event_id" text,
	"subscription_id" text,
	"event_type" text NOT NULL,
	"event_version" text,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_status" "raw_processing_status" DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_helix_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint" text NOT NULL,
	"request_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status_code" integer NOT NULL,
	"response_json" jsonb,
	"pagination" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rate_limit_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ingestion_run_id" uuid,
	"processing_status" "raw_processing_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_irc_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_line" text NOT NULL,
	"parsed_command" text,
	"tags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channel_login" text,
	"bot_account_id" uuid,
	"irc_connection_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_status" "raw_processing_status" DEFAULT 'pending' NOT NULL,
	"parse_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_id_hash" text PRIMARY KEY NOT NULL,
	"app_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stream_activity_buckets" (
	"twitch_stream_id" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"bucket_minutes" integer NOT NULL,
	"viewer_count_min" integer,
	"viewer_count_max" integer,
	"viewer_count_avg" integer,
	"message_count" integer DEFAULT 0 NOT NULL,
	"join_count" integer DEFAULT 0 NOT NULL,
	"part_count" integer DEFAULT 0 NOT NULL,
	"active_chatter_count" integer,
	"event_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stream_activity_buckets_twitch_stream_id_bucket_start_bucket_minutes_pk" PRIMARY KEY("twitch_stream_id","bucket_start","bucket_minutes")
);
--> statement-breakpoint
CREATE TABLE "stream_sessions" (
	"twitch_stream_id" text PRIMARY KEY NOT NULL,
	"broadcaster_user_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_live_at" timestamp with time zone DEFAULT now() NOT NULL,
	"end_detection_source" text,
	"language" text,
	"initial_title" text,
	"latest_title" text,
	"initial_category_id" text,
	"initial_category_name" text,
	"latest_category_id" text,
	"latest_category_name" text,
	"mature" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stream_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"twitch_stream_id" text NOT NULL,
	"broadcaster_user_id" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"viewer_count" integer,
	"title" text,
	"category_id" text,
	"category_name" text,
	"language" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"thumbnail_url" text,
	"source_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twitch_user_name_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"twitch_user_id" text NOT NULL,
	"login" text NOT NULL,
	"display_name" text NOT NULL,
	"observed_from" timestamp with time zone DEFAULT now() NOT NULL,
	"observed_until" timestamp with time zone,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twitch_users" (
	"twitch_user_id" text PRIMARY KEY NOT NULL,
	"login" text,
	"display_name" text,
	"account_type" text,
	"broadcaster_type" text,
	"description" text,
	"profile_image_url" text,
	"offline_image_url" text,
	"twitch_created_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_metadata_refresh_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_name" text NOT NULL,
	"loop_name" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_heartbeats_worker_name_loop_name_pk" PRIMARY KEY("worker_name","loop_name")
);
--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_twitch_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("twitch_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_users" ADD CONSTRAINT "app_users_twitch_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("twitch_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_account_tokens" ADD CONSTRAINT "bot_account_tokens_bot_account_id_bot_accounts_id_fk" FOREIGN KEY ("bot_account_id") REFERENCES "public"."bot_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_accounts" ADD CONSTRAINT "bot_accounts_twitch_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("twitch_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_daily_stats" ADD CONSTRAINT "channel_daily_stats_broadcaster_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("broadcaster_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_broadcaster_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("broadcaster_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_twitch_stream_id_stream_sessions_twitch_stream_id_fk" FOREIGN KEY ("twitch_stream_id") REFERENCES "public"."stream_sessions"("twitch_stream_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_actor_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_raw_eventsub_event_id_raw_eventsub_events_id_fk" FOREIGN KEY ("raw_eventsub_event_id") REFERENCES "public"."raw_eventsub_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_raw_irc_message_id_raw_irc_messages_id_fk" FOREIGN KEY ("raw_irc_message_id") REFERENCES "public"."raw_irc_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_twitch_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("twitch_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_assignment_events" ADD CONSTRAINT "chat_assignment_events_chat_assignment_id_chat_assignments_id_fk" FOREIGN KEY ("chat_assignment_id") REFERENCES "public"."chat_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_assignments" ADD CONSTRAINT "chat_assignments_bot_account_id_bot_accounts_id_fk" FOREIGN KEY ("bot_account_id") REFERENCES "public"."bot_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_assignments" ADD CONSTRAINT "chat_assignments_broadcaster_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("broadcaster_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_assignments" ADD CONSTRAINT "chat_assignments_twitch_stream_id_stream_sessions_twitch_stream_id_fk" FOREIGN KEY ("twitch_stream_id") REFERENCES "public"."stream_sessions"("twitch_stream_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_membership_events" ADD CONSTRAINT "chat_membership_events_broadcaster_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("broadcaster_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_membership_events" ADD CONSTRAINT "chat_membership_events_chatter_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("chatter_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_membership_events" ADD CONSTRAINT "chat_membership_events_twitch_stream_id_stream_sessions_twitch_stream_id_fk" FOREIGN KEY ("twitch_stream_id") REFERENCES "public"."stream_sessions"("twitch_stream_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_membership_events" ADD CONSTRAINT "chat_membership_events_irc_connection_id_irc_connections_id_fk" FOREIGN KEY ("irc_connection_id") REFERENCES "public"."irc_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_membership_events" ADD CONSTRAINT "chat_membership_events_raw_irc_message_id_raw_irc_messages_id_fk" FOREIGN KEY ("raw_irc_message_id") REFERENCES "public"."raw_irc_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_broadcaster_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("broadcaster_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_twitch_stream_id_stream_sessions_twitch_stream_id_fk" FOREIGN KEY ("twitch_stream_id") REFERENCES "public"."stream_sessions"("twitch_stream_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chatter_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("chatter_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_raw_irc_message_id_raw_irc_messages_id_fk" FOREIGN KEY ("raw_irc_message_id") REFERENCES "public"."raw_irc_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_raw_eventsub_event_id_raw_eventsub_events_id_fk" FOREIGN KEY ("raw_eventsub_event_id") REFERENCES "public"."raw_eventsub_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_room_state_events" ADD CONSTRAINT "chat_room_state_events_broadcaster_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("broadcaster_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_room_state_events" ADD CONSTRAINT "chat_room_state_events_bot_account_id_bot_accounts_id_fk" FOREIGN KEY ("bot_account_id") REFERENCES "public"."bot_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_room_state_events" ADD CONSTRAINT "chat_room_state_events_raw_irc_message_id_raw_irc_messages_id_fk" FOREIGN KEY ("raw_irc_message_id") REFERENCES "public"."raw_irc_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatter_channel_activity_buckets" ADD CONSTRAINT "chatter_channel_activity_buckets_chatter_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("chatter_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatter_channel_activity_buckets" ADD CONSTRAINT "chatter_channel_activity_buckets_broadcaster_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("broadcaster_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chatter_daily_stats" ADD CONSTRAINT "chatter_daily_stats_chatter_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("chatter_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "irc_connections" ADD CONSTRAINT "irc_connections_bot_account_id_bot_accounts_id_fk" FOREIGN KEY ("bot_account_id") REFERENCES "public"."bot_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_app_user_id_app_users_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raids" ADD CONSTRAINT "raids_source_broadcaster_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("source_broadcaster_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raids" ADD CONSTRAINT "raids_target_broadcaster_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("target_broadcaster_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raids" ADD CONSTRAINT "raids_source_stream_id_stream_sessions_twitch_stream_id_fk" FOREIGN KEY ("source_stream_id") REFERENCES "public"."stream_sessions"("twitch_stream_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raids" ADD CONSTRAINT "raids_target_stream_id_stream_sessions_twitch_stream_id_fk" FOREIGN KEY ("target_stream_id") REFERENCES "public"."stream_sessions"("twitch_stream_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raids" ADD CONSTRAINT "raids_raw_eventsub_event_id_raw_eventsub_events_id_fk" FOREIGN KEY ("raw_eventsub_event_id") REFERENCES "public"."raw_eventsub_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_observations" ADD CONSTRAINT "rate_limit_observations_bot_account_id_bot_accounts_id_fk" FOREIGN KEY ("bot_account_id") REFERENCES "public"."bot_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_helix_responses" ADD CONSTRAINT "raw_helix_responses_ingestion_run_id_ingestion_runs_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_irc_messages" ADD CONSTRAINT "raw_irc_messages_bot_account_id_bot_accounts_id_fk" FOREIGN KEY ("bot_account_id") REFERENCES "public"."bot_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_irc_messages" ADD CONSTRAINT "raw_irc_messages_irc_connection_id_irc_connections_id_fk" FOREIGN KEY ("irc_connection_id") REFERENCES "public"."irc_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_app_user_id_app_users_id_fk" FOREIGN KEY ("app_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_activity_buckets" ADD CONSTRAINT "stream_activity_buckets_twitch_stream_id_stream_sessions_twitch_stream_id_fk" FOREIGN KEY ("twitch_stream_id") REFERENCES "public"."stream_sessions"("twitch_stream_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_sessions" ADD CONSTRAINT "stream_sessions_broadcaster_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("broadcaster_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_snapshots" ADD CONSTRAINT "stream_snapshots_twitch_stream_id_stream_sessions_twitch_stream_id_fk" FOREIGN KEY ("twitch_stream_id") REFERENCES "public"."stream_sessions"("twitch_stream_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stream_snapshots" ADD CONSTRAINT "stream_snapshots_broadcaster_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("broadcaster_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twitch_user_name_history" ADD CONSTRAINT "twitch_user_name_history_twitch_user_id_twitch_users_twitch_user_id_fk" FOREIGN KEY ("twitch_user_id") REFERENCES "public"."twitch_users"("twitch_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_users_twitch_user_idx" ON "app_users" USING btree ("twitch_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_accounts_login_idx" ON "bot_accounts" USING btree ("login");--> statement-breakpoint
CREATE INDEX "channel_events_channel_occurred_idx" ON "channel_events" USING btree ("broadcaster_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "channel_events_source_event_idx" ON "channel_events" USING btree ("source","source_event_id");--> statement-breakpoint
CREATE INDEX "chat_assignments_active_idx" ON "chat_assignments" USING btree ("status","priority_score");--> statement-breakpoint
CREATE INDEX "chat_assignments_channel_idx" ON "chat_assignments" USING btree ("broadcaster_user_id","status");--> statement-breakpoint
CREATE INDEX "chat_membership_events_channel_received_idx" ON "chat_membership_events" USING btree ("broadcaster_user_id","received_at");--> statement-breakpoint
CREATE INDEX "chat_membership_events_chatter_received_idx" ON "chat_membership_events" USING btree ("chatter_user_id","received_at");--> statement-breakpoint
CREATE INDEX "chat_messages_channel_received_idx" ON "chat_messages" USING btree ("broadcaster_user_id","received_at");--> statement-breakpoint
CREATE INDEX "chat_messages_chatter_received_idx" ON "chat_messages" USING btree ("chatter_user_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_accounts_provider_user_idx" ON "oauth_accounts" USING btree ("provider","provider_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_eventsub_events_message_idx" ON "raw_eventsub_events" USING btree ("twitch_message_id");--> statement-breakpoint
CREATE INDEX "raw_eventsub_events_type_received_idx" ON "raw_eventsub_events" USING btree ("event_type","received_at");--> statement-breakpoint
CREATE INDEX "raw_irc_messages_received_idx" ON "raw_irc_messages" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "raw_irc_messages_channel_received_idx" ON "raw_irc_messages" USING btree ("channel_login","received_at");--> statement-breakpoint
CREATE INDEX "stream_sessions_broadcaster_live_idx" ON "stream_sessions" USING btree ("broadcaster_user_id","ended_at");--> statement-breakpoint
CREATE INDEX "stream_sessions_started_at_idx" ON "stream_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "stream_snapshots_stream_observed_idx" ON "stream_snapshots" USING btree ("twitch_stream_id","observed_at");--> statement-breakpoint
CREATE INDEX "stream_snapshots_broadcaster_observed_idx" ON "stream_snapshots" USING btree ("broadcaster_user_id","observed_at");--> statement-breakpoint
CREATE INDEX "twitch_user_name_history_user_observed_idx" ON "twitch_user_name_history" USING btree ("twitch_user_id","observed_from");