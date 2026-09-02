CREATE TYPE "public"."finnish_stream_match_reason" AS ENUM('language', 'tag', 'manual');--> statement-breakpoint
ALTER TABLE "stream_sessions" ADD COLUMN "finnish_match_reason" "finnish_stream_match_reason";--> statement-breakpoint
ALTER TABLE "stream_sessions" ADD COLUMN "is_finnish_eligible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
WITH classified AS (
	SELECT sessions."twitch_stream_id",
		CASE
			WHEN lower(coalesce(sessions."language", '')) = 'fi' THEN 'language'
			WHEN EXISTS (
				SELECT 1
				FROM jsonb_array_elements_text(coalesce(metadata."tags", '[]'::jsonb)) AS tag(value)
				WHERE lower(btrim(tag.value)) IN ('suomi', 'finnish')
			) THEN 'tag'
			WHEN channels."is_manually_pinned" = true THEN 'manual'
			ELSE NULL
		END::"finnish_stream_match_reason" AS match_reason
	FROM "stream_sessions" AS sessions
	LEFT JOIN LATERAL (
		SELECT snapshots."tags"
		FROM "stream_snapshots" AS snapshots
		WHERE snapshots."twitch_stream_id" = sessions."twitch_stream_id"
			AND snapshots."title" IS NOT NULL
		ORDER BY snapshots."observed_at" DESC, snapshots."id" DESC
		LIMIT 1
	) AS metadata ON true
	LEFT JOIN "channels" AS channels ON channels."twitch_user_id" = sessions."broadcaster_user_id"
)
UPDATE "stream_sessions" AS sessions
SET "finnish_match_reason" = classified.match_reason,
	"is_finnish_eligible" = classified.match_reason IS NOT NULL
FROM classified
WHERE classified."twitch_stream_id" = sessions."twitch_stream_id";--> statement-breakpoint
CREATE INDEX "stream_sessions_live_finnish_idx" ON "stream_sessions" USING btree ("last_seen_live_at") WHERE "ended_at" IS NULL AND "is_finnish_eligible" = true;--> statement-breakpoint
CREATE INDEX "stream_sessions_recent_finnish_ended_idx" ON "stream_sessions" USING btree ("ended_at") WHERE "ended_at" IS NOT NULL AND "finnish_match_reason" IS NOT NULL;
