import { chatAssignments, streamSessions, streamSnapshots, subjectPrivacyStates } from "@twitch-tracker/db";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { resolvePrimaryBotCredentials } from "../bot-auth.js";
import type { WorkerContext } from "../worker.js";
import { startIntervalLoop } from "./common.js";

const activeAssignmentStatuses = ["desired", "joining", "joined"] as const;

export const runAssignmentLoop = (context: WorkerContext) => {
  startIntervalLoop({
    name: "assignment",
    intervalMs: context.config.ASSIGNMENT_INTERVAL_MS,
    context,
    run: async () => {
      if (!context.config.ENABLE_TWITCH_INGESTION) {
        return { assignmentsDesired: 0, skipped: "ENABLE_TWITCH_INGESTION is false." };
      }

      const bot = await resolvePrimaryBotCredentials(context.db, context.config);
      if (bot.botAccountId == null || bot.login == null) {
        return { assignmentsDesired: 0, skipped: "No enabled bot account is configured." };
      }

      if (bot.accessToken == null) {
        return { assignmentsDesired: 0, skipped: "No valid bot access token is configured.", botLogin: bot.login };
      }

      const capacity = bot.maxJoinedRooms;
      if (capacity <= 0) {
        return { assignmentsDesired: 0, skipped: "Bot join capacity is 0.", botLogin: bot.login };
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
      const selectedStreamIds = new Set(streams.map((row) => row.stream.twitchStreamId));

      for (const row of streams) {
        const stream = row.stream;
        const priorityScore = row.viewerCount ?? 0;
        await context.db
          .insert(chatAssignments)
          .values({
            botAccountId: bot.botAccountId,
            broadcasterUserId: stream.broadcasterUserId,
            twitchStreamId: stream.twitchStreamId,
            status: "desired",
            priorityScore,
            reason: "top_live_finnish_viewer_rank"
          })
          .onConflictDoUpdate({
            target: [chatAssignments.botAccountId, chatAssignments.broadcasterUserId, chatAssignments.twitchStreamId],
            set: {
              status: sql`
                case
                  when ${chatAssignments.status} = 'leaving' and ${chatAssignments.joinedAt} is not null then 'joined'::assignment_status
                  when ${chatAssignments.status} in ('left', 'failed', 'leaving') then 'desired'::assignment_status
                  else ${chatAssignments.status}
                end
              `,
              priorityScore,
              reason: "top_live_finnish_viewer_rank",
              joinedAt: sql`
                case
                  when ${chatAssignments.status} in ('left', 'failed') then null
                  else ${chatAssignments.joinedAt}
                end
              `,
              leftAt: sql`
                case
                  when ${chatAssignments.status} in ('left', 'failed', 'leaving') then null
                  else ${chatAssignments.leftAt}
                end
              `,
              latestError: sql`
                case
                  when ${chatAssignments.status} in ('left', 'failed', 'leaving') then null
                  else ${chatAssignments.latestError}
                end
              `,
              updatedAt: new Date()
            }
          });
      }

      const retiredAssignments = await retireAssignmentsOutsideCapacity(context, bot.botAccountId, selectedStreamIds);

      return {
        assignmentsDesired: streams.length,
        retiredAssignments,
        topViewerCount: streams[0]?.viewerCount ?? null,
        botLogin: bot.login,
        botTokenSource: bot.source
      };
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

const retireAssignmentsOutsideCapacity = async (
  context: WorkerContext,
  botAccountId: string,
  selectedStreamIds: Set<string>
): Promise<number> => {
  const activeAssignments = await context.db
    .select({
      id: chatAssignments.id,
      status: chatAssignments.status,
      twitchStreamId: chatAssignments.twitchStreamId
    })
    .from(chatAssignments)
    .where(and(eq(chatAssignments.botAccountId, botAccountId), inArray(chatAssignments.status, [...activeAssignmentStatuses])));

  let retired = 0;
  for (const assignment of activeAssignments) {
    if (assignment.twitchStreamId != null && selectedStreamIds.has(assignment.twitchStreamId)) {
      continue;
    }

    const now = new Date();
    const nextStatus = assignment.status === "desired" ? "left" : "leaving";
    await context.db
      .update(chatAssignments)
      .set({
        status: nextStatus,
        leftAt: nextStatus === "left" ? now : null,
        reason: "outside_top_live_finnish_capacity",
        updatedAt: now
      })
      .where(eq(chatAssignments.id, assignment.id));
    retired += 1;
  }

  return retired;
};
