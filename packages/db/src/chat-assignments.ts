import { and, count, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { DbClient } from "./index.js";
import {
  channels,
  chatAssignmentEvents,
  chatAssignments,
  streamSessions,
  streamSnapshots,
  subjectPrivacyStates,
  twitchUsers
} from "./schema.js";

export const activeChatAssignmentStatuses = ["desired", "joining", "joined", "leaving"] as const;

export type ActiveChatAssignmentStatus = (typeof activeChatAssignmentStatuses)[number];
export type ChatAssignmentStatus = typeof chatAssignments.$inferSelect.status;

export type AssignmentCandidate = {
  twitchStreamId: string;
  broadcasterUserId: string;
  viewerCount: number | null;
  lastSeenLiveAt: Date;
  isManuallyPinned: boolean;
  isOptedIn: boolean;
  isKnownModerator: boolean;
  trackingPriority: number;
};

export type ChatAssignmentObservation =
  | {
      type: "join_command_sent";
      assignmentId: string;
      observedAt: Date;
    }
  | {
      type: "leave_processed";
      assignmentId: string;
      observedAt: Date;
    }
  | {
      type: "room_observed";
      botAccountId: string;
      broadcasterUserId: string;
      observedAt: Date;
      lastMessageAt?: Date;
      lastMembershipEventAt?: Date;
    }
  | {
      type: "room_parted";
      botAccountId: string;
      broadcasterUserId: string;
      observedAt: Date;
    }
  | {
      type: "socket_disconnected";
      botAccountId: string;
      reason: string;
      observedAt: Date;
    }
  | {
      type: "join_timed_out";
      assignmentId: string;
      observedAt: Date;
    }
  | {
      type: "assignment_failed";
      botAccountId: string;
      broadcasterUserId: string;
      error: string;
      observedAt: Date;
    }
  | {
      type: "tracking_opt_out";
      broadcasterUserId: string;
      observedAt: Date;
    };

type AssignmentRow = Pick<
  typeof chatAssignments.$inferSelect,
  "id" | "status" | "joinedAt" | "twitchStreamId"
>;

type DbTransaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const incumbentStatuses: ChatAssignmentStatus[] = ["desired", "joining", "joined", "leaving"];
const roomReservationStatuses: ChatAssignmentStatus[] = ["joining", "joined"];
const promotableStatuses: ChatAssignmentStatus[] = ["desired", "joining", "joined"];
const terminalRetryStatuses: ChatAssignmentStatus[] = ["left", "failed"];
const viewerHysteresisRatio = 1.25;
const viewerHysteresisMinimum = 10;

export const createChatAssignmentControl = (db: DbClient) => {
  const record = async (observation: ChatAssignmentObservation): Promise<number> => {
    switch (observation.type) {
      case "join_command_sent":
        return transitionById(db, {
          assignmentId: observation.assignmentId,
          expectedStatuses: ["desired"],
          nextStatus: "joining",
          reason: "IRC JOIN command sent",
          details: { source: "irc" },
          observedAt: observation.observedAt,
          set: {
            latestError: null
          }
        });
      case "leave_processed":
        return transitionById(db, {
          assignmentId: observation.assignmentId,
          expectedStatuses: ["leaving"],
          nextStatus: "left",
          reason: "IRC PART processed",
          details: { source: "irc" },
          observedAt: observation.observedAt,
          set: {
            leftAt: observation.observedAt,
            latestError: null
          }
        });
      case "room_observed":
        return recordRoomObserved(db, observation);
      case "room_parted":
        return transitionByBroadcaster(db, {
          botAccountId: observation.botAccountId,
          broadcasterUserId: observation.broadcasterUserId,
          expectedStatuses: ["joining", "joined", "leaving"],
          nextStatus: "left",
          reason: "IRC room parted",
          details: { source: "irc" },
          observedAt: observation.observedAt,
          set: {
            leftAt: observation.observedAt,
            latestError: null
          }
        });
      case "socket_disconnected":
        return recordSocketDisconnected(db, observation);
      case "join_timed_out":
        return transitionById(db, {
          assignmentId: observation.assignmentId,
          expectedStatuses: ["joining"],
          nextStatus: "desired",
          reason: "JOIN acknowledgement timed out",
          details: { source: "irc" },
          observedAt: observation.observedAt,
          set: {
            joinedAt: null,
            latestError: "join acknowledgement timed out; retrying"
          }
        });
      case "assignment_failed":
        return transitionByBroadcaster(db, {
          botAccountId: observation.botAccountId,
          broadcasterUserId: observation.broadcasterUserId,
          expectedStatuses: ["desired", "joining", "joined"],
          nextStatus: "failed",
          reason: "IRC assignment failed",
          details: { source: "irc", error: observation.error },
          observedAt: observation.observedAt,
          set: {
            latestError: observation.error
          }
        });
      case "tracking_opt_out":
        return closeForTrackingOptOut(observation.broadcasterUserId, observation.observedAt);
    }
  };

  const reconcile = async (input: {
    botAccountId: string;
    capacity: number;
    observedAt: Date;
  }): Promise<{
    assignmentsDesired: number;
    retiredAssignments: number;
    topViewerCount: number | null;
  }> => {
    const capacity = Math.max(0, input.capacity);
    const candidates = capacity === 0 ? [] : await readCandidates(db, capacity);
    const existingAssignments = await db
      .select({
        id: chatAssignments.id,
        status: chatAssignments.status,
        joinedAt: chatAssignments.joinedAt,
        twitchStreamId: chatAssignments.twitchStreamId
      })
      .from(chatAssignments)
      .where(eq(chatAssignments.botAccountId, input.botAccountId));
    const incumbentStreamIds = new Set(
      existingAssignments
        .filter((assignment) => incumbentStatuses.includes(assignment.status) && assignment.twitchStreamId != null)
        .map((assignment) => assignment.twitchStreamId as string)
    );
    const selected = selectStableAssignmentCandidates({ candidates, incumbentStreamIds, capacity });
    const selectedStreamIds = new Set(selected.map((candidate) => candidate.twitchStreamId));

    for (const [index, candidate] of selected.entries()) {
      await ensureSelectedAssignment(db, {
        botAccountId: input.botAccountId,
        candidate,
        priorityScore: selected.length - index,
        reason: candidateReason(candidate),
        observedAt: input.observedAt
      });
    }

    let retiredAssignments = 0;
    for (const assignment of existingAssignments) {
      if (
        assignment.twitchStreamId != null &&
        selectedStreamIds.has(assignment.twitchStreamId)
      ) {
        continue;
      }

      if (assignment.status === "desired") {
        retiredAssignments += await transitionById(db, {
          assignmentId: assignment.id,
          expectedStatuses: ["desired"],
          nextStatus: "left",
          reason: "outside selected Finnish Stream capacity",
          details: { source: "assignment_reconciliation" },
          observedAt: input.observedAt,
          set: {
            leftAt: input.observedAt,
            latestError: null
          }
        });
      } else if (assignment.status === "joining" || assignment.status === "joined") {
        retiredAssignments += await transitionById(db, {
          assignmentId: assignment.id,
          expectedStatuses: [assignment.status],
          nextStatus: "leaving",
          reason: "outside selected Finnish Stream capacity",
          details: { source: "assignment_reconciliation" },
          observedAt: input.observedAt,
          set: {
            latestError: null
          }
        });
      }
    }

    return {
      assignmentsDesired: selected.length,
      retiredAssignments,
      topViewerCount: selected.reduce<number | null>((highest, candidate) => {
        if (candidate.viewerCount == null) {
          return highest;
        }
        return highest == null ? candidate.viewerCount : Math.max(highest, candidate.viewerCount);
      }, null)
    };
  };

  const planIrcCommands = async (input: {
    botAccountId: string;
    capacity: number;
    joinRatePer10Seconds: number;
    staleJoiningTimeoutMs: number;
    observedAt: Date;
  }) => {
    const staleCutoff = new Date(input.observedAt.getTime() - input.staleJoiningTimeoutMs);
    const staleAssignments = await db
      .select({ id: chatAssignments.id })
      .from(chatAssignments)
      .where(
        and(
          eq(chatAssignments.botAccountId, input.botAccountId),
          eq(chatAssignments.status, "joining"),
          lt(chatAssignments.updatedAt, staleCutoff)
        )
      )
      .limit(100);

    let staleJoiningRequeued = 0;
    for (const assignment of staleAssignments) {
      staleJoiningRequeued += await record({
        type: "join_timed_out",
        assignmentId: assignment.id,
        observedAt: input.observedAt
      });
    }

    const leave = await db
      .select({
        assignmentId: chatAssignments.id,
        channelLogin: twitchUsers.login
      })
      .from(chatAssignments)
      .leftJoin(twitchUsers, eq(chatAssignments.broadcasterUserId, twitchUsers.twitchUserId))
      .where(
        and(
          eq(chatAssignments.botAccountId, input.botAccountId),
          eq(chatAssignments.status, "leaving")
        )
      )
      .orderBy(desc(chatAssignments.updatedAt))
      .limit(Math.max(0, input.capacity));

    const [{ value: roomReservations } = { value: 0 }] = await db
      .select({ value: count() })
      .from(chatAssignments)
      .where(
        and(
          eq(chatAssignments.botAccountId, input.botAccountId),
          inArray(chatAssignments.status, roomReservationStatuses)
        )
      );
    const availableRoomSlots = Math.max(0, input.capacity - roomReservations);
    const joinCommandLimit = Math.min(availableRoomSlots, Math.max(0, input.joinRatePer10Seconds));
    const join = joinCommandLimit === 0
      ? []
      : await db
          .select({
            assignmentId: chatAssignments.id,
            broadcasterUserId: chatAssignments.broadcasterUserId,
            channelLogin: twitchUsers.login
          })
          .from(chatAssignments)
          .leftJoin(twitchUsers, eq(chatAssignments.broadcasterUserId, twitchUsers.twitchUserId))
          .leftJoin(streamSessions, eq(chatAssignments.twitchStreamId, streamSessions.twitchStreamId))
          .where(
            and(
              eq(chatAssignments.botAccountId, input.botAccountId),
              eq(chatAssignments.status, "desired"),
              isNull(streamSessions.endedAt)
            )
          )
          .orderBy(desc(chatAssignments.priorityScore), desc(chatAssignments.updatedAt))
          .limit(joinCommandLimit);

    return {
      leave,
      join,
      roomReservations,
      availableRoomSlots,
      staleJoiningRequeued
    };
  };

  const closeEndedStreams = async (input: {
    graceMinutes: number;
    observedAt: Date;
  }): Promise<number> => {
    return db.transaction(async (tx) => {
      const endedBefore = new Date(input.observedAt.getTime() - input.graceMinutes * 60_000);
      const rows = await tx
        .select({
          id: chatAssignments.id,
          status: chatAssignments.status,
          joinedAt: chatAssignments.joinedAt,
          twitchStreamId: chatAssignments.twitchStreamId
        })
        .from(chatAssignments)
        .innerJoin(streamSessions, eq(chatAssignments.twitchStreamId, streamSessions.twitchStreamId))
        .where(
          and(
            inArray(chatAssignments.status, incumbentStatuses),
            lt(streamSessions.endedAt, endedBefore)
          )
        )
        .for("update");

      let closed = 0;
      for (const row of rows) {
        closed += await updateAssignment(tx, row, {
          nextStatus: "left",
          reason: "stream ended maintenance cleanup",
          details: { source: "maintenance", twitchStreamId: row.twitchStreamId },
          observedAt: input.observedAt,
          set: {
            leftAt: input.observedAt,
            latestError: null
          }
        });
      }
      return closed;
    });
  };

  const closeForTrackingOptOut = async (
    broadcasterUserId: string,
    observedAt: Date
  ): Promise<number> => {
    return transitionByBroadcaster(db, {
      broadcasterUserId,
      expectedStatuses: incumbentStatuses,
      nextStatus: "left",
      reason: "subject tracking opt-out",
      details: { source: "privacy_request" },
      observedAt,
      set: {
        leftAt: observedAt,
        latestError: null
      }
    });
  };

  const getEffectiveStatuses = async (
    twitchStreamIds: string[]
  ): Promise<Map<string, ActiveChatAssignmentStatus>> => {
    if (twitchStreamIds.length === 0) {
      return new Map();
    }

    const rows = await db
      .select({
        twitchStreamId: chatAssignments.twitchStreamId,
        status: chatAssignments.status
      })
      .from(chatAssignments)
      .where(
        and(
          inArray(chatAssignments.twitchStreamId, twitchStreamIds),
          inArray(chatAssignments.status, activeChatAssignmentStatuses)
        )
      );

    return reduceEffectiveAssignmentStatuses(rows);
  };

  return {
    reconcile,
    planIrcCommands,
    record,
    closeEndedStreams,
    closeForTrackingOptOut,
    getEffectiveStatuses
  };
};

export const selectStableAssignmentCandidates = (input: {
  candidates: AssignmentCandidate[];
  incumbentStreamIds: Set<string>;
  capacity: number;
}): AssignmentCandidate[] => {
  const candidateByStreamId = new Map<string, AssignmentCandidate>();
  for (const candidate of input.candidates) {
    const current = candidateByStreamId.get(candidate.twitchStreamId);
    if (current == null || compareCandidates(candidate, current) < 0) {
      candidateByStreamId.set(candidate.twitchStreamId, candidate);
    }
  }

  const ranked = [...candidateByStreamId.values()].sort(compareCandidates);
  const capacity = Math.max(0, input.capacity);
  const selected = ranked.slice(0, capacity);
  const selectedIds = new Set(selected.map((candidate) => candidate.twitchStreamId));
  const displacedIncumbents = ranked.filter(
    (candidate) => input.incumbentStreamIds.has(candidate.twitchStreamId) && !selectedIds.has(candidate.twitchStreamId)
  );

  for (const incumbent of displacedIncumbents) {
    const weakestChallenger = selected
      .filter((candidate) => !input.incumbentStreamIds.has(candidate.twitchStreamId))
      .sort(compareCandidates)
      .at(-1);
    if (weakestChallenger == null || clearlyOutranks(weakestChallenger, incumbent)) {
      continue;
    }

    const challengerIndex = selected.findIndex(
      (candidate) => candidate.twitchStreamId === weakestChallenger.twitchStreamId
    );
    selected[challengerIndex] = incumbent;
  }

  return selected.sort(compareCandidates);
};

export const reduceEffectiveAssignmentStatuses = (
  rows: Array<{ twitchStreamId: string | null; status: ChatAssignmentStatus }>
): Map<string, ActiveChatAssignmentStatus> => {
  const result = new Map<string, ActiveChatAssignmentStatus>();
  for (const row of rows) {
    if (row.twitchStreamId == null || !isActiveChatAssignmentStatus(row.status)) {
      continue;
    }

    const current = result.get(row.twitchStreamId);
    if (current == null || assignmentStatusRank(row.status) > assignmentStatusRank(current)) {
      result.set(row.twitchStreamId, row.status);
    }
  }
  return result;
};

const readCandidates = async (db: DbClient, capacity: number): Promise<AssignmentCandidate[]> => {
  const latestSnapshotTimes = db
    .select({
      twitchStreamId: streamSnapshots.twitchStreamId,
      observedAt: sql<Date>`max(${streamSnapshots.observedAt})`.as("latest_observed_at")
    })
    .from(streamSnapshots)
    .groupBy(streamSnapshots.twitchStreamId)
    .as("latest_snapshot_times");
  const candidateLimit = Math.max(capacity, Math.min(capacity * 3, 500));
  const rows = await db
    .select({
      twitchStreamId: streamSessions.twitchStreamId,
      broadcasterUserId: streamSessions.broadcasterUserId,
      viewerCount: streamSnapshots.viewerCount,
      lastSeenLiveAt: streamSessions.lastSeenLiveAt,
      isManuallyPinned: channels.isManuallyPinned,
      isOptedIn: channels.isOptedIn,
      isKnownModerator: channels.isKnownModerator,
      trackingPriority: channels.trackingPriority
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
    .leftJoin(channels, eq(streamSessions.broadcasterUserId, channels.twitchUserId))
    .leftJoin(subjectPrivacyStates, eq(streamSessions.broadcasterUserId, subjectPrivacyStates.twitchUserId))
    .where(
      and(
        isNull(streamSessions.endedAt),
        eq(streamSessions.language, "fi"),
        or(isNull(subjectPrivacyStates.twitchUserId), eq(subjectPrivacyStates.trackingOptedOut, false))
      )
    )
    .orderBy(
      desc(sql<number>`case when ${channels.isManuallyPinned} then 2 when ${channels.isOptedIn} or ${channels.isKnownModerator} then 1 else 0 end`),
      desc(sql<number>`coalesce(${channels.trackingPriority}, 0)`),
      desc(sql<number>`coalesce(${streamSnapshots.viewerCount}, -1)`),
      desc(streamSessions.lastSeenLiveAt)
    )
    .limit(candidateLimit);

  return rows.map((row) => ({
    twitchStreamId: row.twitchStreamId,
    broadcasterUserId: row.broadcasterUserId,
    viewerCount: row.viewerCount,
    lastSeenLiveAt: row.lastSeenLiveAt,
    isManuallyPinned: row.isManuallyPinned ?? false,
    isOptedIn: row.isOptedIn ?? false,
    isKnownModerator: row.isKnownModerator ?? false,
    trackingPriority: row.trackingPriority ?? 0
  }));
};

const ensureSelectedAssignment = async (
  db: DbClient,
  input: {
    botAccountId: string;
    candidate: AssignmentCandidate;
    priorityScore: number;
    reason: string;
    observedAt: Date;
  }
) => {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: chatAssignments.id,
        status: chatAssignments.status,
        joinedAt: chatAssignments.joinedAt,
        twitchStreamId: chatAssignments.twitchStreamId
      })
      .from(chatAssignments)
      .where(
        and(
          eq(chatAssignments.botAccountId, input.botAccountId),
          eq(chatAssignments.broadcasterUserId, input.candidate.broadcasterUserId),
          eq(chatAssignments.twitchStreamId, input.candidate.twitchStreamId)
        )
      )
      .limit(1)
      .for("update");

    if (existing == null) {
      const [created] = await tx
        .insert(chatAssignments)
        .values({
          botAccountId: input.botAccountId,
          broadcasterUserId: input.candidate.broadcasterUserId,
          twitchStreamId: input.candidate.twitchStreamId,
          status: "desired",
          priorityScore: input.priorityScore,
          reason: input.reason,
          updatedAt: input.observedAt
        })
        .returning({ id: chatAssignments.id });
      if (created == null) {
        throw new Error("Failed to create Chat Assignment.");
      }
      await insertAssignmentEvent(tx, {
        assignmentId: created.id,
        eventType: "desired",
        reason: input.reason,
        details: { source: "assignment_reconciliation" },
        observedAt: input.observedAt
      });
      return;
    }

    let nextStatus: ChatAssignmentStatus | null = null;
    if (terminalRetryStatuses.includes(existing.status)) {
      nextStatus = "desired";
    } else if (existing.status === "leaving") {
      nextStatus = existing.joinedAt == null ? "desired" : "joined";
    }

    if (nextStatus != null) {
      await updateAssignment(tx, existing, {
        nextStatus,
        reason: input.reason,
        details: { source: "assignment_reconciliation" },
        observedAt: input.observedAt,
        set: {
          priorityScore: input.priorityScore,
          reason: input.reason,
          joinedAt: nextStatus === "desired" ? null : existing.joinedAt,
          leftAt: null,
          latestError: null
        }
      });
      return;
    }

    await tx
      .update(chatAssignments)
      .set({
        priorityScore: input.priorityScore,
        reason: input.reason,
        updatedAt: input.observedAt
      })
      .where(eq(chatAssignments.id, existing.id));
  });
};

const transitionById = async (
  db: DbClient,
  input: {
    assignmentId: string;
    expectedStatuses: ChatAssignmentStatus[];
    nextStatus: ChatAssignmentStatus;
    reason: string;
    details: Record<string, unknown>;
    observedAt: Date;
    set: Partial<typeof chatAssignments.$inferInsert>;
  }
): Promise<number> => {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: chatAssignments.id,
        status: chatAssignments.status,
        joinedAt: chatAssignments.joinedAt,
        twitchStreamId: chatAssignments.twitchStreamId
      })
      .from(chatAssignments)
      .where(
        and(
          eq(chatAssignments.id, input.assignmentId),
          inArray(chatAssignments.status, input.expectedStatuses)
        )
      )
      .limit(1)
      .for("update");
    if (row == null) {
      return 0;
    }
    return updateAssignment(tx, row, input);
  });
};

const transitionByBroadcaster = async (
  db: DbClient,
  input: {
    botAccountId?: string;
    broadcasterUserId: string;
    expectedStatuses: ChatAssignmentStatus[];
    nextStatus: ChatAssignmentStatus;
    reason: string;
    details: Record<string, unknown>;
    observedAt: Date;
    set: Partial<typeof chatAssignments.$inferInsert>;
  }
): Promise<number> => {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: chatAssignments.id,
        status: chatAssignments.status,
        joinedAt: chatAssignments.joinedAt,
        twitchStreamId: chatAssignments.twitchStreamId
      })
      .from(chatAssignments)
      .where(
        and(
          input.botAccountId == null ? undefined : eq(chatAssignments.botAccountId, input.botAccountId),
          eq(chatAssignments.broadcasterUserId, input.broadcasterUserId),
          inArray(chatAssignments.status, input.expectedStatuses)
        )
      )
      .for("update");
    let changed = 0;
    for (const row of rows) {
      changed += await updateAssignment(tx, row, input);
    }
    return changed;
  });
};

const recordRoomObserved = async (
  db: DbClient,
  observation: Extract<ChatAssignmentObservation, { type: "room_observed" }>
): Promise<number> => {
  return db.transaction(async (tx) => {
    const [privacy] = await tx
      .select({ trackingOptedOut: subjectPrivacyStates.trackingOptedOut })
      .from(subjectPrivacyStates)
      .where(eq(subjectPrivacyStates.twitchUserId, observation.broadcasterUserId))
      .limit(1);
    if (privacy?.trackingOptedOut === true) {
      return 0;
    }

    const rows = await tx
      .select({
        id: chatAssignments.id,
        status: chatAssignments.status,
        joinedAt: chatAssignments.joinedAt,
        twitchStreamId: chatAssignments.twitchStreamId
      })
      .from(chatAssignments)
      .where(
        and(
          eq(chatAssignments.botAccountId, observation.botAccountId),
          eq(chatAssignments.broadcasterUserId, observation.broadcasterUserId),
          inArray(chatAssignments.status, promotableStatuses)
        )
      )
      .for("update");

    let changed = 0;
    for (const row of rows) {
      const set: Partial<typeof chatAssignments.$inferInsert> = {
        joinedAt: row.joinedAt ?? observation.observedAt,
        leftAt: null,
        latestError: null
      };
      if (observation.lastMessageAt != null) {
        set.lastMessageAt = observation.lastMessageAt;
      }
      if (observation.lastMembershipEventAt != null) {
        set.lastMembershipEventAt = observation.lastMembershipEventAt;
      }

      changed += await updateAssignment(tx, row, {
        nextStatus: "joined",
        reason: "IRC room observed",
        details: { source: "irc" },
        observedAt: observation.observedAt,
        set
      });
    }
    return changed;
  });
};

const recordSocketDisconnected = async (
  db: DbClient,
  observation: Extract<ChatAssignmentObservation, { type: "socket_disconnected" }>
): Promise<number> => {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: chatAssignments.id,
        status: chatAssignments.status,
        joinedAt: chatAssignments.joinedAt,
        twitchStreamId: chatAssignments.twitchStreamId
      })
      .from(chatAssignments)
      .where(
        and(
          eq(chatAssignments.botAccountId, observation.botAccountId),
          inArray(chatAssignments.status, ["joining", "joined", "leaving"])
        )
      )
      .for("update");

    let changed = 0;
    for (const row of rows) {
      const nextStatus: ChatAssignmentStatus = row.status === "leaving" ? "left" : "desired";
      changed += await updateAssignment(tx, row, {
        nextStatus,
        reason: "IRC socket disconnected",
        details: { source: "irc", reason: observation.reason },
        observedAt: observation.observedAt,
        set: nextStatus === "left"
          ? {
              leftAt: observation.observedAt
            }
          : {
              joinedAt: null,
              leftAt: null,
              latestError: `irc disconnected: ${observation.reason}`
            }
      });
    }
    return changed;
  });
};

const updateAssignment = async (
  tx: DbTransaction,
  row: AssignmentRow,
  input: {
    nextStatus: ChatAssignmentStatus;
    reason: string;
    details: Record<string, unknown>;
    observedAt: Date;
    set: Partial<typeof chatAssignments.$inferInsert>;
  }
): Promise<number> => {
  const set: Partial<typeof chatAssignments.$inferInsert> = {
    ...input.set,
    status: input.nextStatus,
    updatedAt: input.observedAt
  };
  if (row.status !== input.nextStatus) {
    set.reason = input.reason;
  }

  const [updated] = await tx
    .update(chatAssignments)
    .set(set)
    .where(and(eq(chatAssignments.id, row.id), eq(chatAssignments.status, row.status)))
    .returning({ id: chatAssignments.id });
  if (updated == null) {
    return 0;
  }

  if (row.status !== input.nextStatus) {
    await insertAssignmentEvent(tx, {
      assignmentId: row.id,
      eventType: input.nextStatus,
      reason: input.reason,
      details: {
        ...input.details,
        previousStatus: row.status
      },
      observedAt: input.observedAt
    });
  }
  return 1;
};

const insertAssignmentEvent = async (
  tx: DbTransaction,
  input: {
    assignmentId: string;
    eventType: ChatAssignmentStatus;
    reason: string;
    details: Record<string, unknown>;
    observedAt: Date;
  }
) => {
  await tx.insert(chatAssignmentEvents).values({
    chatAssignmentId: input.assignmentId,
    eventType: input.eventType,
    reason: input.reason,
    details: input.details,
    occurredAt: input.observedAt,
    updatedAt: input.observedAt
  });
};

const candidatePriorityClass = (candidate: AssignmentCandidate): number => {
  if (candidate.isManuallyPinned) {
    return 2;
  }
  if (candidate.isOptedIn || candidate.isKnownModerator) {
    return 1;
  }
  return 0;
};

const compareCandidates = (left: AssignmentCandidate, right: AssignmentCandidate): number => {
  const priorityClassDifference = candidatePriorityClass(right) - candidatePriorityClass(left);
  if (priorityClassDifference !== 0) {
    return priorityClassDifference;
  }
  const trackingPriorityDifference = right.trackingPriority - left.trackingPriority;
  if (trackingPriorityDifference !== 0) {
    return trackingPriorityDifference;
  }
  const viewerDifference = (right.viewerCount ?? -1) - (left.viewerCount ?? -1);
  if (viewerDifference !== 0) {
    return viewerDifference;
  }
  const lastSeenDifference = right.lastSeenLiveAt.getTime() - left.lastSeenLiveAt.getTime();
  if (lastSeenDifference !== 0) {
    return lastSeenDifference;
  }
  return left.twitchStreamId.localeCompare(right.twitchStreamId);
};

const clearlyOutranks = (challenger: AssignmentCandidate, incumbent: AssignmentCandidate): boolean => {
  const challengerClass = candidatePriorityClass(challenger);
  const incumbentClass = candidatePriorityClass(incumbent);
  if (challengerClass !== incumbentClass) {
    return challengerClass > incumbentClass;
  }
  if (challenger.trackingPriority !== incumbent.trackingPriority) {
    return challenger.trackingPriority > incumbent.trackingPriority;
  }

  const incumbentViewers = Math.max(0, incumbent.viewerCount ?? 0);
  const requiredViewers = Math.max(
    incumbentViewers + viewerHysteresisMinimum,
    Math.ceil(incumbentViewers * viewerHysteresisRatio)
  );
  return (challenger.viewerCount ?? 0) >= requiredViewers;
};

const candidateReason = (candidate: AssignmentCandidate): string => {
  if (candidate.isManuallyPinned) {
    return "manual_pin";
  }
  if (candidate.isOptedIn || candidate.isKnownModerator) {
    return "authorized_or_moderated";
  }
  if (candidate.trackingPriority !== 0) {
    return "tracking_priority";
  }
  return "live_finnish_viewer_rank";
};

const assignmentStatusRank = (status: ActiveChatAssignmentStatus): number => {
  switch (status) {
    case "joined":
      return 4;
    case "joining":
      return 3;
    case "desired":
      return 2;
    case "leaving":
      return 1;
  }
};

const isActiveChatAssignmentStatus = (status: ChatAssignmentStatus): status is ActiveChatAssignmentStatus => {
  return activeChatAssignmentStatuses.includes(status as ActiveChatAssignmentStatus);
};
