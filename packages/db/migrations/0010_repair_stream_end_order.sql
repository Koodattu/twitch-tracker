UPDATE "stream_sessions"
SET "ended_at" = "last_seen_live_at",
	"updated_at" = now()
WHERE "ended_at" IS NOT NULL
	AND "ended_at" < "last_seen_live_at";
