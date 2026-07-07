import { botAccounts, chatAssignments, streamSessions, streamSnapshots, subjectPrivacyStates } from "@twitch-tracker/db";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import type { WorkerContext } from "../worker.js";
import { startIntervalLoop } from "./common.js";

export const runAssignmentLoop = (context: WorkerContext) => {
  startIntervalLoop({
    name: "assignment",
    intervalMs: context.config.ASSIGNMENT_INTERVAL_MS,
    context,
    run: async () => {
      if (context.config.TWITCH_BOT_LOGIN === "") {
        return { assignmentsDesired: 0, skipped: "TWITCH_BOT_LOGIN is not configured." };
      }

      const [bot] = await context.db
        .insert(botAccounts)
        .values({
          twitchUserId: context.config.TWITCH_BOT_USER_ID || null,
          login: context.config.TWITCH_BOT_LOGIN,
          maxJoinedRooms: context.config.DEFAULT_BOT_JOIN_CAPACITY,
          joinRatePer10Seconds: context.config.DEFAULT_BOT_JOIN_RATE_PER_10_SECONDS
        })
        .onConflictDoUpdate({
          target: botAccounts.login,
          set: {
            enabled: true,
            maxJoinedRooms: context.config.DEFAULT_BOT_JOIN_CAPACITY,
            joinRatePer10Seconds: context.config.DEFAULT_BOT_JOIN_RATE_PER_10_SECONDS,
            updatedAt: new Date()
          }
        })
        .returning({ id: botAccounts.id });

      if (bot == null) {
        throw new Error("Failed to upsert bot account.");
      }

      const capacity = context.config.DEFAULT_BOT_JOIN_CAPACITY;
      if (capacity <= 0) {
        return { assignmentsDesired: 0, skipped: "DEFAULT_BOT_JOIN_CAPACITY is 0." };
      }

      const latestSnapshotTimes = context.db
        .select({
          twitchStreamId: streamSnapshots.twitchStreamId,
          observedAt: sql<Date>`max(${streamSnapshots.observedAt})`.as("latest_observed_at")
        })
        .from(streamSnapshots)
        .groupBy(streamSnapshots.twitchStreamId)
        .as("latest_snapshot_times");

      const candidateLimit = Math.max(capacity, Math.min(capacity * 3, 500));
      const candidateStreams = await context.db
        .select({
          stream: streamSessions,
          viewerCount: streamSnapshots.viewerCount
        })
        .from(streamSessions)
        .leftJoin(latestSnapshotTimes, eq(streamSessions.twitchStreamId, latestSnapshotTimes.twitchStreamId))
        .leftJoin(
          streamSnapshots,
          and(
            eq(streamSnapshots.twitchStreamId, latestSnapshotTimes.twitchStreamId),
            eq(streamSnapshots.observedAt, latestSnapshotTimes.observedAt)
          )
        )
        .leftJoin(subjectPrivacyStates, eq(streamSessions.broadcasterUserId, subjectPrivacyStates.twitchUserId))
        .where(
          and(
            isNull(streamSessions.endedAt),
            eq(streamSessions.language, "fi"),
            or(isNull(subjectPrivacyStates.twitchUserId), eq(subjectPrivacyStates.trackingOptedOut, false))
          )
        )
        .orderBy(desc(sql<number>`coalesce(${streamSnapshots.viewerCount}, -1)`), desc(streamSessions.lastSeenLiveAt))
        .limit(candidateLimit);
      const streams = uniqueAssignmentCandidates(candidateStreams).slice(0, capacity);

      for (const row of streams) {
        const stream = row.stream;
        const priorityScore = row.viewerCount ?? 0;
        await context.db
          .insert(chatAssignments)
          .values({
            botAccountId: bot.id,
            broadcasterUserId: stream.broadcasterUserId,
            twitchStreamId: stream.twitchStreamId,
            status: "desired",
            priorityScore,
            reason: "top_live_finnish_viewer_rank"
          })
          .onConflictDoUpdate({
            target: [chatAssignments.botAccountId, chatAssignments.broadcasterUserId, chatAssignments.twitchStreamId],
            set: {
              priorityScore,
              reason: "top_live_finnish_viewer_rank",
              updatedAt: new Date()
            }
          });
      }

      return { assignmentsDesired: streams.length, topViewerCount: streams[0]?.viewerCount ?? null };
    }
  });
};

const uniqueAssignmentCandidates = <T extends { stream: { twitchStreamId: string } }>(rows: T[]): T[] => {
  const seen = new Set<string>();
  const uniqueRows: T[] = [];
  for (const row of rows) {
    if (seen.has(row.stream.twitchStreamId)) {
      continue;
    }

    seen.add(row.stream.twitchStreamId);
    uniqueRows.push(row);
  }

  return uniqueRows;
};
