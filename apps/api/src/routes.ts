import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, hashSessionToken, parseScopeList, type AppConfig } from "@twitch-tracker/config";
import {
  adminUsers,
  appUsers,
  chatAssignments,
  chatMembershipEvents,
  chatMessages,
  chatPresenceObservations,
  chatPresenceSnapshots,
  botAccounts,
  botAccountTokens,
  channelDailyStats,
  channelEvents,
  eventProcessingFailures,
  eventsubSubscriptions,
  ingestionRuns,
  oauthAccounts,
  rateLimitObservations,
  privacyRequestEvents,
  privacyRequests,
  raids,
  rawEventsubEvents,
  rawIrcMessages,
  sessions,
  subjectPrivacyStates,
  streamActivityBuckets,
  streamSessions,
  streamSnapshots,
  twitchUsers,
  workerHeartbeats,
  type DbClient
} from "@twitch-tracker/db";
import { createEventSubEnvelope, eventSubHeaders, exchangeTwitchAuthorizationCode, FetchHelixAdapter, refreshTwitchUserAccessToken, validateTwitchAccessToken, verifyEventSubSignature } from "@twitch-tracker/twitch";
import { and, desc, eq, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

type ApiBindings = {
  Variables: {
    config: AppConfig;
    db: DbClient;
  };
};

type CreateApiAppInput = {
  config: AppConfig;
  db: DbClient;
};

const loginParamSchema = z.object({ login: z.string().min(1).max(100) });
const streamParamSchema = z.object({ streamId: z.string().min(1).max(100) });
const privacyRequestParamSchema = z.object({ requestId: z.string().uuid() });
const privacyRequestBodySchema = z.object({
  requestType: z.enum(["public_profile_opt_out", "tracking_opt_out", "data_deletion"]),
  note: z.string().max(1000).optional()
});
const messageArchiveQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  q: z.string().trim().max(100).default("")
});
const sessionCookieName = "twitch_tracker_session";
const oauthStateCookieName = "twitch_oauth_state";
const botOauthStateCookieName = "twitch_bot_oauth_state";
const activeChatAssignmentStatuses = ["desired", "joining", "joined", "leaving"] as const;
type ActiveChatAssignmentStatus = (typeof activeChatAssignmentStatuses)[number];
const messageArchivePageSize = 100;
const twitchTokenValidationIntervalMs = 55 * 60 * 1000;

export const createApiApp = ({ config, db }: CreateApiAppInput) => {
  const app = new Hono<ApiBindings>();

  app.use("*", async (c, next) => {
    c.set("config", config);
    c.set("db", db);
    await next();
  });

  app.get("/api/health", (c) => {
    return c.json({
      data: {
        ok: true,
        mode: c.get("config").APP_MODE,
        timestamp: new Date().toISOString()
      }
    });
  });

  app.get("/api/streams/live", async (c) => {
    const db = c.get("db");
    const canSeeSuppressed = await hasAdminAccess(c);
    const latestSnapshotTimes = db
      .select({
        twitchStreamId: streamSnapshots.twitchStreamId,
        observedAt: sql<Date>`max(${streamSnapshots.observedAt})`.as("latest_observed_at")
      })
      .from(streamSnapshots)
      .groupBy(streamSnapshots.twitchStreamId)
      .as("latest_snapshot_times");

    const rows = await db
      .select({
        streamId: streamSessions.twitchStreamId,
        broadcasterId: streamSessions.broadcasterUserId,
        broadcasterLogin: twitchUsers.login,
        broadcasterDisplayName: twitchUsers.displayName,
        broadcasterProfileImageUrl: twitchUsers.profileImageUrl,
        title: streamSessions.latestTitle,
        categoryName: streamSessions.latestCategoryName,
        language: streamSessions.language,
        viewerCount: streamSnapshots.viewerCount,
        viewerObservedAt: streamSnapshots.observedAt,
        startedAt: streamSessions.startedAt,
        firstSeenAt: streamSessions.firstSeenAt,
        lastSeenLiveAt: streamSessions.lastSeenLiveAt
      })
      .from(streamSessions)
      .leftJoin(twitchUsers, eq(streamSessions.broadcasterUserId, twitchUsers.twitchUserId))
      .leftJoin(latestSnapshotTimes, eq(streamSessions.twitchStreamId, latestSnapshotTimes.twitchStreamId))
      .leftJoin(
        streamSnapshots,
        and(
          eq(streamSnapshots.twitchStreamId, latestSnapshotTimes.twitchStreamId),
          eq(streamSnapshots.observedAt, latestSnapshotTimes.observedAt)
        )
      )
      .leftJoin(subjectPrivacyStates, eq(streamSessions.broadcasterUserId, subjectPrivacyStates.twitchUserId))
      .where(canSeeSuppressed
        ? and(isNull(streamSessions.endedAt), eq(streamSessions.language, "fi"))
        : and(
            isNull(streamSessions.endedAt),
            eq(streamSessions.language, "fi"),
            or(isNull(subjectPrivacyStates.twitchUserId), eq(subjectPrivacyStates.trackingOptedOut, false))
          ))
      .orderBy(desc(sql<number>`coalesce(${streamSnapshots.viewerCount}, -1)`), desc(streamSessions.lastSeenLiveAt))
      .limit(200);

    const liveRows = uniqueByStreamId(rows).slice(0, 100);
    const streamIds = liveRows.map((row) => row.streamId);
    const assignmentRows =
      streamIds.length === 0
        ? []
        : await db
            .select({
              twitchStreamId: chatAssignments.twitchStreamId,
              status: chatAssignments.status
            })
            .from(chatAssignments)
            .where(and(inArray(chatAssignments.twitchStreamId, streamIds), inArray(chatAssignments.status, [...activeChatAssignmentStatuses])));
    const assignmentStatusByStream = new Map<string, ActiveChatAssignmentStatus>();
    for (const assignment of assignmentRows) {
      if (assignment.twitchStreamId == null || !isActiveChatAssignmentStatus(assignment.status)) {
        continue;
      }

      const currentStatus = assignmentStatusByStream.get(assignment.twitchStreamId);
      if (currentStatus == null || rankChatAssignmentStatus(assignment.status) > rankChatAssignmentStatus(currentStatus)) {
        assignmentStatusByStream.set(assignment.twitchStreamId, assignment.status);
      }
    }

    return c.json({
      data: liveRows.map((row) => {
        const chatAssignmentStatus = assignmentStatusByStream.get(row.streamId) ?? null;
        return {
          ...row,
          viewerObservedAt: row.viewerObservedAt?.toISOString() ?? null,
          chatAssignmentStatus,
          isChatTracked: chatAssignmentStatus === "joined",
          startedAt: row.startedAt.toISOString(),
          firstSeenAt: row.firstSeenAt.toISOString(),
          lastSeenLiveAt: row.lastSeenLiveAt.toISOString()
        };
      })
    });
  });

  app.get("/api/streams/recent", async (c) => {
    const canSeeSuppressed = await hasAdminAccess(c);
    const rows = await c
      .get("db")
      .select({ stream: streamSessions })
      .from(streamSessions)
      .leftJoin(subjectPrivacyStates, eq(streamSessions.broadcasterUserId, subjectPrivacyStates.twitchUserId))
      .where(canSeeSuppressed
        ? undefined
        : or(isNull(subjectPrivacyStates.twitchUserId), eq(subjectPrivacyStates.trackingOptedOut, false)))
      .orderBy(desc(streamSessions.startedAt))
      .limit(50);

    return c.json({ data: rows.map((row) => row.stream) });
  });

  app.get("/api/streams/:streamId/activity", async (c) => {
    const params = streamParamSchema.parse(c.req.param());
    const db = c.get("db");
    const [row] = await db
      .select({
        stream: streamSessions,
        publicProfileHidden: subjectPrivacyStates.publicProfileHidden,
        trackingOptedOut: subjectPrivacyStates.trackingOptedOut
      })
      .from(streamSessions)
      .leftJoin(subjectPrivacyStates, eq(streamSessions.broadcasterUserId, subjectPrivacyStates.twitchUserId))
      .where(eq(streamSessions.twitchStreamId, params.streamId))
      .limit(1);

    if (row == null) {
      return c.json({ error: { code: "not_found", message: "Stream not found." } }, 404);
    }

    if (isSubjectSuppressed(row) && !(await hasPrivilegedAccess(c))) {
      return c.json({ error: { code: "not_found", message: "Stream not found." } }, 404);
    }

    const [totals] = await db
      .select({
        viewerCountMax: sql<number | null>`max(${streamActivityBuckets.viewerCountMax})`,
        viewerCountAvg: sql<number | null>`round(avg(${streamActivityBuckets.viewerCountAvg}) filter (where ${streamActivityBuckets.viewerCountAvg} is not null))::int`,
        messageCount: sql<number>`coalesce(sum(${streamActivityBuckets.messageCount}), 0)::int`,
        joinCount: sql<number>`coalesce(sum(${streamActivityBuckets.joinCount}), 0)::int`,
        partCount: sql<number>`coalesce(sum(${streamActivityBuckets.partCount}), 0)::int`,
        activeChatterCountMax: sql<number | null>`max(${streamActivityBuckets.activeChatterCount})`
      })
      .from(streamActivityBuckets)
      .where(eq(streamActivityBuckets.twitchStreamId, params.streamId));

    const snapshots = await db
      .select({
        observedAt: streamSnapshots.observedAt,
        viewerCount: streamSnapshots.viewerCount,
        title: streamSnapshots.title,
        categoryName: streamSnapshots.categoryName
      })
      .from(streamSnapshots)
      .where(eq(streamSnapshots.twitchStreamId, params.streamId))
      .orderBy(desc(streamSnapshots.observedAt))
      .limit(500);

    const buckets = await db
      .select({
        bucketStart: streamActivityBuckets.bucketStart,
        bucketMinutes: streamActivityBuckets.bucketMinutes,
        viewerCountMin: streamActivityBuckets.viewerCountMin,
        viewerCountMax: streamActivityBuckets.viewerCountMax,
        viewerCountAvg: streamActivityBuckets.viewerCountAvg,
        messageCount: streamActivityBuckets.messageCount,
        joinCount: streamActivityBuckets.joinCount,
        partCount: streamActivityBuckets.partCount,
        activeChatterCount: streamActivityBuckets.activeChatterCount,
        eventCounts: streamActivityBuckets.eventCounts
      })
      .from(streamActivityBuckets)
      .where(eq(streamActivityBuckets.twitchStreamId, params.streamId))
      .orderBy(desc(streamActivityBuckets.bucketStart))
      .limit(300);

    const events = await db
      .select({
        id: channelEvents.id,
        eventType: channelEvents.eventType,
        actorUserId: channelEvents.actorUserId,
        occurredAt: channelEvents.occurredAt,
        source: channelEvents.source,
        sourceEventId: channelEvents.sourceEventId
      })
      .from(channelEvents)
      .where(eq(channelEvents.twitchStreamId, params.streamId))
      .orderBy(desc(channelEvents.occurredAt))
      .limit(100);

    const streamRaids = await db
      .select({
        id: raids.id,
        sourceBroadcasterUserId: raids.sourceBroadcasterUserId,
        targetBroadcasterUserId: raids.targetBroadcasterUserId,
        viewerCount: raids.viewerCount,
        occurredAt: raids.occurredAt
      })
      .from(raids)
      .where(or(eq(raids.sourceStreamId, params.streamId), eq(raids.targetStreamId, params.streamId)))
      .orderBy(desc(raids.occurredAt))
      .limit(100);

    return c.json({
      data: {
        totals: {
          viewerCountMax: totals?.viewerCountMax ?? null,
          viewerCountAvg: totals?.viewerCountAvg ?? null,
          messageCount: totals?.messageCount ?? 0,
          joinCount: totals?.joinCount ?? 0,
          partCount: totals?.partCount ?? 0,
          activeChatterCountMax: totals?.activeChatterCountMax ?? null
        },
        snapshots: snapshots.map((snapshot) => ({
          ...snapshot,
          observedAt: snapshot.observedAt.toISOString()
        })),
        buckets: buckets.map((bucket) => ({
          ...bucket,
          bucketStart: bucket.bucketStart.toISOString()
        })),
        events: events.map((event) => ({
          ...event,
          occurredAt: event.occurredAt.toISOString()
        })),
        raids: streamRaids.map((raid) => ({
          ...raid,
          occurredAt: raid.occurredAt.toISOString()
        }))
      }
    });
  });

  app.get("/api/streams/:streamId", async (c) => {
    const params = streamParamSchema.parse(c.req.param());
    const [row] = await c
      .get("db")
      .select({
        stream: streamSessions,
        broadcasterLogin: twitchUsers.login,
        broadcasterDisplayName: twitchUsers.displayName,
        broadcasterProfileImageUrl: twitchUsers.profileImageUrl,
        publicProfileHidden: subjectPrivacyStates.publicProfileHidden,
        trackingOptedOut: subjectPrivacyStates.trackingOptedOut
      })
      .from(streamSessions)
      .leftJoin(twitchUsers, eq(streamSessions.broadcasterUserId, twitchUsers.twitchUserId))
      .leftJoin(subjectPrivacyStates, eq(streamSessions.broadcasterUserId, subjectPrivacyStates.twitchUserId))
      .where(eq(streamSessions.twitchStreamId, params.streamId))
      .limit(1);

    if (row == null) {
      return c.json({ error: { code: "not_found", message: "Stream not found." } }, 404);
    }

    if (isSubjectSuppressed(row) && !(await hasPrivilegedAccess(c))) {
      return c.json({ error: { code: "not_found", message: "Stream not found." } }, 404);
    }

    return c.json({
      data: {
        ...row.stream,
        broadcasterLogin: row.broadcasterLogin,
        broadcasterDisplayName: row.broadcasterDisplayName,
        broadcasterProfileImageUrl: row.broadcasterProfileImageUrl
      }
    });
  });

  app.get("/api/channels/:login", async (c) => {
    const params = loginParamSchema.parse(c.req.param());
    const [row] = await c
      .get("db")
      .select({
        user: twitchUsers,
        publicProfileHidden: subjectPrivacyStates.publicProfileHidden,
        trackingOptedOut: subjectPrivacyStates.trackingOptedOut
      })
      .from(twitchUsers)
      .leftJoin(subjectPrivacyStates, eq(twitchUsers.twitchUserId, subjectPrivacyStates.twitchUserId))
      .where(eq(twitchUsers.login, params.login.toLowerCase()))
      .limit(1);

    if (row == null) {
      return c.json({ error: { code: "not_found", message: "Channel not found." } }, 404);
    }

    if (isSubjectSuppressed(row) && !(await hasPrivilegedAccess(c))) {
      return c.json({ error: { code: "not_found", message: "Channel not found." } }, 404);
    }

    return c.json({ data: row.user });
  });

  app.get("/api/channels/:login/streams", async (c) => {
    const params = loginParamSchema.parse(c.req.param());
    const [channel] = await c
      .get("db")
      .select({
        twitchUserId: twitchUsers.twitchUserId,
        publicProfileHidden: subjectPrivacyStates.publicProfileHidden,
        trackingOptedOut: subjectPrivacyStates.trackingOptedOut
      })
      .from(twitchUsers)
      .leftJoin(subjectPrivacyStates, eq(twitchUsers.twitchUserId, subjectPrivacyStates.twitchUserId))
      .where(eq(twitchUsers.login, params.login.toLowerCase()))
      .limit(1);

    if (channel == null) {
      return c.json({ error: { code: "not_found", message: "Channel not found." } }, 404);
    }

    if (isSubjectSuppressed(channel) && !(await hasPrivilegedAccess(c))) {
      return c.json({ error: { code: "not_found", message: "Channel not found." } }, 404);
    }

    const rows = await c
      .get("db")
      .select({
        stream: streamSessions
      })
      .from(streamSessions)
      .leftJoin(twitchUsers, eq(streamSessions.broadcasterUserId, twitchUsers.twitchUserId))
      .where(eq(streamSessions.broadcasterUserId, channel.twitchUserId))
      .orderBy(desc(streamSessions.startedAt))
      .limit(50);

    return c.json({ data: rows.map((row) => row.stream) });
  });

  app.get("/api/channels/:login/viewer-history", async (c) => {
    const params = loginParamSchema.parse(c.req.param());
    const [channel] = await c
      .get("db")
      .select({
        twitchUserId: twitchUsers.twitchUserId,
        publicProfileHidden: subjectPrivacyStates.publicProfileHidden,
        trackingOptedOut: subjectPrivacyStates.trackingOptedOut
      })
      .from(twitchUsers)
      .leftJoin(subjectPrivacyStates, eq(twitchUsers.twitchUserId, subjectPrivacyStates.twitchUserId))
      .where(eq(twitchUsers.login, params.login.toLowerCase()))
      .limit(1);

    if (channel == null) {
      return c.json({ error: { code: "not_found", message: "Channel not found." } }, 404);
    }

    if (isSubjectSuppressed(channel) && !(await hasPrivilegedAccess(c))) {
      return c.json({ error: { code: "not_found", message: "Channel not found." } }, 404);
    }

    const rows = await c
      .get("db")
      .select({
        twitchStreamId: streamSnapshots.twitchStreamId,
        observedAt: streamSnapshots.observedAt,
        viewerCount: streamSnapshots.viewerCount,
        title: streamSnapshots.title,
        categoryId: streamSnapshots.categoryId,
        categoryName: streamSnapshots.categoryName,
        thumbnailUrl: streamSnapshots.thumbnailUrl
      })
      .from(streamSnapshots)
      .where(eq(streamSnapshots.broadcasterUserId, channel.twitchUserId))
      .orderBy(desc(streamSnapshots.observedAt))
      .limit(500);

    return c.json({
      data: rows.map((row) => ({
        ...row,
        observedAt: row.observedAt.toISOString()
      }))
    });
  });

  app.get("/api/channels/:login/activity", async (c) => {
    const params = loginParamSchema.parse(c.req.param());
    const [channel] = await c
      .get("db")
      .select({
        twitchUserId: twitchUsers.twitchUserId,
        publicProfileHidden: subjectPrivacyStates.publicProfileHidden,
        trackingOptedOut: subjectPrivacyStates.trackingOptedOut
      })
      .from(twitchUsers)
      .leftJoin(subjectPrivacyStates, eq(twitchUsers.twitchUserId, subjectPrivacyStates.twitchUserId))
      .where(eq(twitchUsers.login, params.login.toLowerCase()))
      .limit(1);

    if (channel == null) {
      return c.json({ error: { code: "not_found", message: "Channel not found." } }, 404);
    }

    if (isSubjectSuppressed(channel) && !(await hasPrivilegedAccess(c))) {
      return c.json({ error: { code: "not_found", message: "Channel not found." } }, 404);
    }

    const daily = await c
      .get("db")
      .select({
        day: channelDailyStats.day,
        streamCount: channelDailyStats.streamCount,
        liveSeconds: channelDailyStats.liveSeconds,
        viewerCountMax: channelDailyStats.viewerCountMax,
        viewerCountAvg: channelDailyStats.viewerCountAvg,
        messageCount: channelDailyStats.messageCount,
        aggregateEngagement: channelDailyStats.aggregateEngagement
      })
      .from(channelDailyStats)
      .where(eq(channelDailyStats.broadcasterUserId, channel.twitchUserId))
      .orderBy(desc(channelDailyStats.day))
      .limit(90);

    const recentBuckets = await c
      .get("db")
      .select({
        twitchStreamId: streamActivityBuckets.twitchStreamId,
        bucketStart: streamActivityBuckets.bucketStart,
        bucketMinutes: streamActivityBuckets.bucketMinutes,
        viewerCountMin: streamActivityBuckets.viewerCountMin,
        viewerCountMax: streamActivityBuckets.viewerCountMax,
        viewerCountAvg: streamActivityBuckets.viewerCountAvg,
        messageCount: streamActivityBuckets.messageCount,
        joinCount: streamActivityBuckets.joinCount,
        partCount: streamActivityBuckets.partCount,
        activeChatterCount: streamActivityBuckets.activeChatterCount,
        eventCounts: streamActivityBuckets.eventCounts
      })
      .from(streamActivityBuckets)
      .innerJoin(streamSessions, eq(streamActivityBuckets.twitchStreamId, streamSessions.twitchStreamId))
      .where(eq(streamSessions.broadcasterUserId, channel.twitchUserId))
      .orderBy(desc(streamActivityBuckets.bucketStart))
      .limit(200);

    const [totals] = await c
      .get("db")
      .select({
        streamCount: sql<number>`coalesce(sum(${channelDailyStats.streamCount}), 0)::int`,
        liveSeconds: sql<number>`coalesce(sum(${channelDailyStats.liveSeconds}), 0)::int`,
        messageCount: sql<number>`coalesce(sum(${channelDailyStats.messageCount}), 0)::int`,
        viewerCountMax: sql<number | null>`max(${channelDailyStats.viewerCountMax})`,
        viewerCountAvg: sql<number | null>`round(avg(${channelDailyStats.viewerCountAvg}) filter (where ${channelDailyStats.viewerCountAvg} is not null))::int`
      })
      .from(channelDailyStats)
      .where(eq(channelDailyStats.broadcasterUserId, channel.twitchUserId));

    return c.json({
      data: {
        totals: {
          streamCount: totals?.streamCount ?? 0,
          liveSeconds: totals?.liveSeconds ?? 0,
          messageCount: totals?.messageCount ?? 0,
          viewerCountMax: totals?.viewerCountMax ?? null,
          viewerCountAvg: totals?.viewerCountAvg ?? null
        },
        daily,
        recentBuckets: recentBuckets.map((bucket) => ({
          ...bucket,
          bucketStart: bucket.bucketStart.toISOString()
        }))
      }
    });
  });

  app.get("/api/chatters/:login", async (c) => {
    const params = loginParamSchema.parse(c.req.param());
    const [row] = await c
      .get("db")
      .select({
        login: twitchUsers.login,
        publicProfileHidden: subjectPrivacyStates.publicProfileHidden,
        trackingOptedOut: subjectPrivacyStates.trackingOptedOut
      })
      .from(twitchUsers)
      .leftJoin(subjectPrivacyStates, eq(twitchUsers.twitchUserId, subjectPrivacyStates.twitchUserId))
      .where(eq(twitchUsers.login, params.login.toLowerCase()))
      .limit(1);

    const hasDetailAccess = await hasPrivilegedAccess(c);
    if (row != null && isSubjectSuppressed(row) && !hasDetailAccess) {
      return c.json({
        data: {
          login: row.login ?? params.login,
          publicSummary: true,
          detailAvailable: false,
          hiddenBySubjectRequest: true
        }
      });
    }

    return c.json({
      data: {
        login: row?.login ?? params.login,
        publicSummary: true,
        detailAvailable: hasDetailAccess
      }
    });
  });

  app.get("/api/me", async (c) => {
    const session = await getCurrentSession(c);
    const apiConfig = c.get("config");

    return c.json({
      data: {
        user: session?.user ?? null,
        mode: apiConfig.APP_MODE,
        authConfigured: isTwitchLoginConfigured(apiConfig)
      }
    });
  });

  app.get("/api/me/data", async (c) => {
    const session = await getCurrentSession(c);
    if (session == null) {
      return c.json({ error: { code: "unauthorized", message: "Log in with Twitch to view your data." } }, 401);
    }

    const [summary] = await c
      .get("db")
      .select({
        messageCount: sql<number>`count(*)::int`,
        channelCount: sql<number>`count(distinct ${chatMessages.broadcasterUserId})::int`,
        firstMessageAt: sql<Date | null>`min(${chatMessages.receivedAt})`,
        lastMessageAt: sql<Date | null>`max(${chatMessages.receivedAt})`
      })
      .from(chatMessages)
      .where(eq(chatMessages.chatterUserId, session.user.twitchUserId));

    const recentMessages = await c
      .get("db")
      .select({
        messageId: chatMessages.twitchMessageId,
        broadcasterUserId: chatMessages.broadcasterUserId,
        broadcasterLogin: twitchUsers.login,
        broadcasterDisplayName: twitchUsers.displayName,
        twitchStreamId: chatMessages.twitchStreamId,
        sentAt: chatMessages.sentAt,
        receivedAt: chatMessages.receivedAt,
        rawText: chatMessages.rawText,
        source: chatMessages.source
      })
      .from(chatMessages)
      .leftJoin(twitchUsers, eq(chatMessages.broadcasterUserId, twitchUsers.twitchUserId))
      .where(eq(chatMessages.chatterUserId, session.user.twitchUserId))
      .orderBy(desc(chatMessages.receivedAt))
      .limit(100);

    return c.json({
      data: {
        user: session.user,
        summary: {
          messageCount: summary?.messageCount ?? 0,
          channelCount: summary?.channelCount ?? 0,
          firstMessageAt: summary?.firstMessageAt?.toISOString() ?? null,
          lastMessageAt: summary?.lastMessageAt?.toISOString() ?? null
        },
        recentMessages: recentMessages.map((message) => ({
          ...message,
          sentAt: message.sentAt?.toISOString() ?? null,
          receivedAt: message.receivedAt.toISOString()
        }))
      }
    });
  });

  app.get("/api/me/privacy", async (c) => {
    const session = await getCurrentSession(c);
    if (session == null) {
      return c.json({ error: { code: "unauthorized", message: "Log in with Twitch to manage privacy controls." } }, 401);
    }

    const state = await getSubjectPrivacyState(c.get("db"), session.user.twitchUserId);
    const requests = await c
      .get("db")
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.subjectTwitchUserId, session.user.twitchUserId))
      .orderBy(desc(privacyRequests.requestedAt))
      .limit(20);

    return c.json({
      data: {
        state: serializeSubjectPrivacyState(state),
        requests: requests.map(serializePrivacyRequest)
      }
    });
  });

  app.post("/api/me/privacy/requests", async (c) => {
    const session = await getCurrentSession(c);
    if (session == null) {
      return c.json({ error: { code: "unauthorized", message: "Log in with Twitch to manage privacy controls." } }, 401);
    }

    const body = privacyRequestBodySchema.parse(await readRequestBody(c));
    const now = new Date();
    const [request] = await c
      .get("db")
      .insert(privacyRequests)
      .values({
        requestType: body.requestType,
        status: "pending",
        subjectTwitchUserId: session.user.twitchUserId,
        requestedByAppUserId: session.user.appUserId,
        details: body.note == null || body.note.trim() === "" ? {} : { note: body.note.trim() },
        requestedAt: now,
        updatedAt: now
      })
      .returning();

    if (request == null) {
      return c.json({ error: { code: "privacy_request_failed", message: "Privacy request could not be recorded." } }, 500);
    }

    await c.get("db").insert(privacyRequestEvents).values({
      privacyRequestId: request.id,
      eventType: "created",
      actorAppUserId: session.user.appUserId,
      details: {},
      occurredAt: now
    });

    const completed = body.requestType === "data_deletion"
      ? null
      : await completePrivacyRequest(c.get("db"), request.id, session.user.appUserId);

    return c.json({
      data: {
        request: serializePrivacyRequest(completed ?? request),
        state: serializeSubjectPrivacyState(await getSubjectPrivacyState(c.get("db"), session.user.twitchUserId))
      }
    }, body.requestType === "data_deletion" ? 202 : 201);
  });

  app.get("/api/auth/twitch/start", (c) => {
    const apiConfig = c.get("config");
    if (!isTwitchLoginConfigured(apiConfig)) {
      return c.json({ error: { code: "not_configured", message: "Twitch OAuth is not configured." } }, 501);
    }

    const state = randomBytes(24).toString("hex");
    setCookie(c, oauthStateCookieName, state, {
      httpOnly: true,
      secure: apiConfig.COOKIE_SECURE,
      sameSite: "Lax",
      path: "/",
      maxAge: 600
    });

    const url = new URL("https://id.twitch.tv/oauth2/authorize");
    url.searchParams.set("client_id", apiConfig.TWITCH_CLIENT_ID);
    url.searchParams.set("redirect_uri", apiConfig.TWITCH_OAUTH_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    const scopes = parseScopeList(apiConfig.TWITCH_LOGIN_SCOPES);
    if (scopes.length > 0) {
      url.searchParams.set("scope", scopes.join(" "));
    }

    return c.redirect(url.toString());
  });

  app.get("/api/auth/twitch/callback", async (c) => {
    const apiConfig = c.get("config");
    const state = c.req.query("state");
    const code = c.req.query("code");
    const oauthError = c.req.query("error");
    const expectedState = getCookie(c, oauthStateCookieName);

    if (state == null || expectedState == null || state !== expectedState) {
      return redirectToOwnData(c, "invalid_state");
    }

    clearCookie(c, oauthStateCookieName, apiConfig);

    if (oauthError != null || code == null || code === "") {
      return redirectToOwnData(c, oauthError === "access_denied" ? "cancelled" : "failed");
    }

    if (!isTwitchLoginConfigured(apiConfig)) {
      return redirectToOwnData(c, "not_configured");
    }

    try {
      const token = await exchangeTwitchAuthorizationCode({
        clientId: apiConfig.TWITCH_CLIENT_ID,
        clientSecret: apiConfig.TWITCH_CLIENT_SECRET,
        code,
        redirectUri: apiConfig.TWITCH_OAUTH_REDIRECT_URI
      });
      const validation = await validateTwitchAccessToken(token.accessToken);

      if (validation.clientId !== apiConfig.TWITCH_CLIENT_ID || validation.userId == null) {
        return c.json({ error: { code: "invalid_twitch_token", message: "Twitch returned an invalid login token." } }, 502);
      }

      const helix = new FetchHelixAdapter(apiConfig.TWITCH_CLIENT_ID);
      const usersResponse = await helix.getUsers({
        ids: [validation.userId],
        accessToken: token.accessToken
      });

      if (usersResponse.statusCode < 200 || usersResponse.statusCode >= 300) {
        return c.json({ error: { code: "twitch_user_lookup_failed", message: "Twitch user lookup failed." } }, 502);
      }

      const twitchUser = usersResponse.responseJson.data[0];
      if (twitchUser == null) {
        return c.json({ error: { code: "twitch_user_not_found", message: "Twitch user lookup did not return a user." } }, 502);
      }

      const now = new Date();
      await c
        .get("db")
        .insert(twitchUsers)
        .values({
          twitchUserId: twitchUser.id,
          login: twitchUser.login,
          displayName: twitchUser.display_name,
          accountType: twitchUser.type,
          broadcasterType: twitchUser.broadcaster_type,
          description: twitchUser.description,
          profileImageUrl: twitchUser.profile_image_url,
          offlineImageUrl: twitchUser.offline_image_url,
          twitchCreatedAt: new Date(twitchUser.created_at),
          lastSeenAt: now,
          lastMetadataRefreshAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: twitchUsers.twitchUserId,
          set: {
            login: twitchUser.login,
            displayName: twitchUser.display_name,
            accountType: twitchUser.type,
            broadcasterType: twitchUser.broadcaster_type,
            description: twitchUser.description,
            profileImageUrl: twitchUser.profile_image_url,
            offlineImageUrl: twitchUser.offline_image_url,
            twitchCreatedAt: new Date(twitchUser.created_at),
            lastSeenAt: now,
            lastMetadataRefreshAt: now,
            updatedAt: now
          }
        });

      await persistConfiguredAdminGrant(c.get("db"), apiConfig, {
        twitchUserId: twitchUser.id,
        login: twitchUser.login
      }, now);

      const [appUser] = await c
        .get("db")
        .insert(appUsers)
        .values({
          twitchUserId: twitchUser.id,
          lastLoginAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: appUsers.twitchUserId,
          set: {
            lastLoginAt: now,
            updatedAt: now
          }
        })
        .returning({
          id: appUsers.id,
          isAdmin: appUsers.isAdmin
        });

      if (appUser == null) {
        return c.json({ error: { code: "app_user_persistence_failed", message: "Login could not be persisted." } }, 500);
      }

      const tokenExpiresAt = new Date(now.getTime() + token.expiresInSeconds * 1000);
      await c
        .get("db")
        .insert(oauthAccounts)
        .values({
          appUserId: appUser.id,
          provider: "twitch",
          providerUserId: twitchUser.id,
          scopes: token.scopes,
          encryptedAccessToken: encryptSecret(token.accessToken, apiConfig.SESSION_SECRET),
          encryptedRefreshToken: token.refreshToken == null ? null : encryptSecret(token.refreshToken, apiConfig.SESSION_SECRET),
          expiresAt: tokenExpiresAt,
          lastValidatedAt: now,
          refreshStatus: "valid",
          latestError: null,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: [oauthAccounts.provider, oauthAccounts.providerUserId],
          set: {
            appUserId: appUser.id,
            scopes: token.scopes,
            encryptedAccessToken: encryptSecret(token.accessToken, apiConfig.SESSION_SECRET),
            encryptedRefreshToken: token.refreshToken == null ? null : encryptSecret(token.refreshToken, apiConfig.SESSION_SECRET),
            expiresAt: tokenExpiresAt,
            lastValidatedAt: now,
            refreshStatus: "valid",
            latestError: null,
            updatedAt: now
          }
        });

      const sessionToken = randomBytes(32).toString("base64url");
      const sessionIdHash = hashSessionToken(sessionToken, apiConfig.SESSION_SECRET);
      const sessionMaxAgeSeconds = apiConfig.SESSION_TTL_DAYS * 24 * 60 * 60;
      await c.get("db").insert(sessions).values({
        sessionIdHash,
        appUserId: appUser.id,
        expiresAt: new Date(now.getTime() + sessionMaxAgeSeconds * 1000),
        lastSeenAt: now,
        updatedAt: now
      });

      setCookie(c, sessionCookieName, sessionToken, {
        httpOnly: true,
        secure: apiConfig.COOKIE_SECURE,
        sameSite: "Lax",
        path: "/",
        maxAge: sessionMaxAgeSeconds
      });
      return c.redirect(new URL("/me", apiConfig.PUBLIC_WEB_URL).toString());
    } catch {
      return redirectToOwnData(c, "failed");
    }
  });

  app.post("/api/auth/logout", async (c) => {
    const apiConfig = c.get("config");
    const sessionToken = getCookie(c, sessionCookieName);
    if (sessionToken != null && sessionToken !== "") {
      const now = new Date();
      await c
        .get("db")
        .update(sessions)
        .set({ revokedAt: now, updatedAt: now })
        .where(eq(sessions.sessionIdHash, hashSessionToken(sessionToken, apiConfig.SESSION_SECRET)));
    }

    clearCookie(c, sessionCookieName, apiConfig);

    if (c.req.header("accept")?.includes("text/html") === true) {
      return c.redirect(new URL("/", apiConfig.PUBLIC_WEB_URL).toString(), 303);
    }

    return c.json({ data: { ok: true } });
  });

  app.get("/api/internal/messages", requireAdmin, async (c) => {
    const query = messageArchiveQuerySchema.parse({
      page: c.req.query("page"),
      q: c.req.query("q") ?? ""
    });
    const db = c.get("db");
    const searchPattern = query.q === "" ? null : `%${escapeLikePattern(query.q)}%`;
    const searchCondition = searchPattern == null
      ? undefined
      : or(
          ilike(chatMessages.chatterLogin, searchPattern),
          ilike(chatMessages.rawText, searchPattern),
          ilike(twitchUsers.login, searchPattern),
          ilike(twitchUsers.displayName, searchPattern),
          ilike(streamSessions.twitchStreamId, searchPattern),
          ilike(streamSessions.latestTitle, searchPattern)
        );

    const [summary] = await db
      .select({
        messageCount: sql<number>`count(*)::int`,
        chatterCount: sql<number>`count(distinct coalesce(${chatMessages.chatterUserId}, ${chatMessages.chatterLogin}))::int`,
        channelCount: sql<number>`count(distinct ${chatMessages.broadcasterUserId})::int`,
        streamCount: sql<number>`count(distinct ${chatMessages.twitchStreamId})::int`
      })
      .from(chatMessages);

    const [matches] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(chatMessages)
      .leftJoin(twitchUsers, eq(chatMessages.broadcasterUserId, twitchUsers.twitchUserId))
      .leftJoin(streamSessions, eq(chatMessages.twitchStreamId, streamSessions.twitchStreamId))
      .where(searchCondition);

    const totalMatches = matches?.count ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalMatches / messageArchivePageSize));
    const page = Math.min(query.page, totalPages);
    const messages = await db
      .select({
        messageId: chatMessages.twitchMessageId,
        chatterUserId: chatMessages.chatterUserId,
        chatterLogin: chatMessages.chatterLogin,
        broadcasterUserId: chatMessages.broadcasterUserId,
        broadcasterLogin: twitchUsers.login,
        broadcasterDisplayName: twitchUsers.displayName,
        twitchStreamId: chatMessages.twitchStreamId,
        streamTitle: streamSessions.latestTitle,
        streamStartedAt: streamSessions.startedAt,
        sentAt: chatMessages.sentAt,
        receivedAt: chatMessages.receivedAt,
        rawText: chatMessages.rawText,
        source: chatMessages.source,
        messageType: chatMessages.messageType,
        deletedAt: chatMessages.deletedAt,
        clearedAt: chatMessages.clearedAt
      })
      .from(chatMessages)
      .leftJoin(twitchUsers, eq(chatMessages.broadcasterUserId, twitchUsers.twitchUserId))
      .leftJoin(streamSessions, eq(chatMessages.twitchStreamId, streamSessions.twitchStreamId))
      .where(searchCondition)
      .orderBy(desc(chatMessages.receivedAt), desc(chatMessages.twitchMessageId))
      .limit(messageArchivePageSize)
      .offset((page - 1) * messageArchivePageSize);

    return c.json({
      data: {
        summary: {
          messageCount: summary?.messageCount ?? 0,
          chatterCount: summary?.chatterCount ?? 0,
          channelCount: summary?.channelCount ?? 0,
          streamCount: summary?.streamCount ?? 0
        },
        messages: messages.map((message) => ({
          ...message,
          streamStartedAt: toIso(message.streamStartedAt),
          sentAt: toIso(message.sentAt),
          receivedAt: message.receivedAt.toISOString(),
          deletedAt: toIso(message.deletedAt),
          clearedAt: toIso(message.clearedAt)
        })),
        pagination: {
          page,
          pageSize: messageArchivePageSize,
          totalMatches,
          totalPages
        },
        query: query.q
      }
    });
  });

  app.get("/api/internal/ingestion", requireAdmin, async (c) => {
    const [assignmentCount] = await c
      .get("db")
      .select({ count: sql<number>`count(*)::int` })
      .from(chatAssignments)
      .where(inArray(chatAssignments.status, [...activeChatAssignmentStatuses]));

    const heartbeats = await c.get("db").select().from(workerHeartbeats).limit(50);
    const recentRuns = await c.get("db").select().from(ingestionRuns).orderBy(desc(ingestionRuns.startedAt)).limit(20);
    const subscriptionStatuses = await c
      .get("db")
      .select({
        status: eventsubSubscriptions.status,
        count: sql<number>`count(*)::int`
      })
      .from(eventsubSubscriptions)
      .groupBy(eventsubSubscriptions.status);

    return c.json({
      data: {
        mode: c.get("config").APP_MODE,
        workerHeartbeats: heartbeats.map((heartbeat) => ({
          workerName: heartbeat.workerName,
          loopName: heartbeat.loopName,
          status: heartbeat.status,
          lastHeartbeatAt: heartbeat.lastHeartbeatAt.toISOString()
        })),
        activeAssignments: assignmentCount?.count ?? 0,
        recentRuns: recentRuns.map((run) => ({
          jobType: run.jobType,
          status: run.status,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null
        })),
        eventSubSubscriptions: subscriptionStatuses
      }
    });
  });

  app.get("/api/internal/bot-accounts", requireAdmin, async (c) => {
    const accounts = await c.get("db").select().from(botAccounts).orderBy(desc(botAccounts.updatedAt)).limit(100);
    const accountIds = accounts.map((account) => account.id);
    const tokens =
      accountIds.length === 0
        ? []
        : await c
            .get("db")
            .select({
              id: botAccountTokens.id,
              botAccountId: botAccountTokens.botAccountId,
              scopes: botAccountTokens.scopes,
              expiresAt: botAccountTokens.expiresAt,
              lastValidatedAt: botAccountTokens.lastValidatedAt,
              refreshStatus: botAccountTokens.refreshStatus,
              updatedAt: botAccountTokens.updatedAt,
              encryptedAccessToken: botAccountTokens.encryptedAccessToken,
              encryptedRefreshToken: botAccountTokens.encryptedRefreshToken
            })
            .from(botAccountTokens)
            .where(inArray(botAccountTokens.botAccountId, accountIds))
            .orderBy(desc(botAccountTokens.updatedAt));

    const latestTokenByAccount = new Map<string, (typeof tokens)[number]>();
    for (const token of tokens) {
      if (!latestTokenByAccount.has(token.botAccountId)) {
        latestTokenByAccount.set(token.botAccountId, token);
      }
    }

    return c.json({
      data: accounts.map((account) => {
        const token = latestTokenByAccount.get(account.id);
        return {
          ...account,
          token:
            token == null
              ? null
              : {
                  id: token.id,
                  scopes: token.scopes,
                  expiresAt: toIso(token.expiresAt),
                  lastValidatedAt: toIso(token.lastValidatedAt),
                  refreshStatus: token.refreshStatus,
                  updatedAt: token.updatedAt.toISOString(),
                  hasAccessToken: token.encryptedAccessToken != null,
                  hasRefreshToken: token.encryptedRefreshToken != null
                }
        };
      })
    });
  });

  app.get("/api/internal/bot-accounts/oauth/start", requireAdmin, (c) => {
    const apiConfig = c.get("config");
    if (
      apiConfig.TWITCH_CLIENT_ID === "" ||
      apiConfig.TWITCH_CLIENT_SECRET === "" ||
      apiConfig.TWITCH_BOT_OAUTH_REDIRECT_URI == null ||
      apiConfig.TWITCH_BOT_OAUTH_REDIRECT_URI === ""
    ) {
      return c.json({ error: { code: "not_configured", message: "Bot OAuth is not configured." } }, 501);
    }

    const state = randomBytes(24).toString("hex");
    setCookie(c, botOauthStateCookieName, state, {
      httpOnly: true,
      secure: apiConfig.COOKIE_SECURE,
      sameSite: "Lax",
      path: "/",
      maxAge: 600
    });

    const url = new URL("https://id.twitch.tv/oauth2/authorize");
    url.searchParams.set("client_id", apiConfig.TWITCH_CLIENT_ID);
    url.searchParams.set("redirect_uri", apiConfig.TWITCH_BOT_OAUTH_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    const scopes = parseScopeList(apiConfig.TWITCH_BOT_SCOPES);
    if (scopes.length > 0) {
      url.searchParams.set("scope", scopes.join(" "));
    }

    return c.redirect(url.toString());
  });

  app.get("/api/internal/bot-accounts/oauth/callback", requireAdmin, async (c) => {
    const apiConfig = c.get("config");
    const state = c.req.query("state");
    const code = c.req.query("code");
    const expectedState = getCookie(c, botOauthStateCookieName);

    if (state == null || expectedState == null || state !== expectedState) {
      return c.json({ error: { code: "invalid_oauth_state", message: "OAuth state validation failed." } }, 400);
    }

    if (code == null || code === "") {
      return c.json({ error: { code: "missing_oauth_code", message: "OAuth callback is missing a code." } }, 400);
    }

    if (
      apiConfig.TWITCH_CLIENT_ID === "" ||
      apiConfig.TWITCH_CLIENT_SECRET === "" ||
      apiConfig.TWITCH_BOT_OAUTH_REDIRECT_URI == null ||
      apiConfig.TWITCH_BOT_OAUTH_REDIRECT_URI === ""
    ) {
      return c.json({ error: { code: "not_configured", message: "Bot OAuth is not configured." } }, 501);
    }

    try {
      const token = await exchangeTwitchAuthorizationCode({
        clientId: apiConfig.TWITCH_CLIENT_ID,
        clientSecret: apiConfig.TWITCH_CLIENT_SECRET,
        code,
        redirectUri: apiConfig.TWITCH_BOT_OAUTH_REDIRECT_URI
      });
      const validation = await validateTwitchAccessToken(token.accessToken);

      if (validation.clientId !== apiConfig.TWITCH_CLIENT_ID || validation.userId == null || validation.login == null) {
        return c.json({ error: { code: "invalid_twitch_token", message: "Twitch returned an invalid bot token." } }, 502);
      }

      const helix = new FetchHelixAdapter(apiConfig.TWITCH_CLIENT_ID);
      const usersResponse = await helix.getUsers({
        ids: [validation.userId],
        accessToken: token.accessToken
      });

      if (usersResponse.statusCode < 200 || usersResponse.statusCode >= 300) {
        return c.json({ error: { code: "twitch_user_lookup_failed", message: "Twitch user lookup failed." } }, 502);
      }

      const twitchUser = usersResponse.responseJson.data[0];
      if (twitchUser == null) {
        return c.json({ error: { code: "twitch_user_not_found", message: "Twitch user lookup did not return a user." } }, 502);
      }

      const now = new Date();
      await c
        .get("db")
        .insert(twitchUsers)
        .values({
          twitchUserId: twitchUser.id,
          login: twitchUser.login,
          displayName: twitchUser.display_name,
          accountType: twitchUser.type,
          broadcasterType: twitchUser.broadcaster_type,
          description: twitchUser.description,
          profileImageUrl: twitchUser.profile_image_url,
          offlineImageUrl: twitchUser.offline_image_url,
          twitchCreatedAt: new Date(twitchUser.created_at),
          lastSeenAt: now,
          lastMetadataRefreshAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: twitchUsers.twitchUserId,
          set: {
            login: twitchUser.login,
            displayName: twitchUser.display_name,
            accountType: twitchUser.type,
            broadcasterType: twitchUser.broadcaster_type,
            description: twitchUser.description,
            profileImageUrl: twitchUser.profile_image_url,
            offlineImageUrl: twitchUser.offline_image_url,
            twitchCreatedAt: new Date(twitchUser.created_at),
            lastSeenAt: now,
            lastMetadataRefreshAt: now,
            updatedAt: now
          }
        });

      const [bot] = await c
        .get("db")
        .insert(botAccounts)
        .values({
          twitchUserId: twitchUser.id,
          login: twitchUser.login,
          enabled: true,
          maxJoinedRooms: apiConfig.DEFAULT_BOT_JOIN_CAPACITY,
          joinRatePer10Seconds: apiConfig.DEFAULT_BOT_JOIN_RATE_PER_10_SECONDS,
          healthStatus: "ok",
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: botAccounts.login,
          set: {
            twitchUserId: twitchUser.id,
            enabled: true,
            maxJoinedRooms: apiConfig.DEFAULT_BOT_JOIN_CAPACITY,
            joinRatePer10Seconds: apiConfig.DEFAULT_BOT_JOIN_RATE_PER_10_SECONDS,
            healthStatus: "ok",
            updatedAt: now
          }
        })
        .returning({ id: botAccounts.id });

      if (bot == null) {
        return c.json({ error: { code: "bot_account_persistence_failed", message: "Bot account could not be persisted." } }, 500);
      }

      await c
        .get("db")
        .update(botAccountTokens)
        .set({
          refreshStatus: "superseded",
          updatedAt: now
        })
        .where(eq(botAccountTokens.botAccountId, bot.id));

      await c.get("db").insert(botAccountTokens).values({
        botAccountId: bot.id,
        scopes: token.scopes,
        encryptedAccessToken: encryptSecret(token.accessToken, apiConfig.SESSION_SECRET),
        encryptedRefreshToken: token.refreshToken == null ? null : encryptSecret(token.refreshToken, apiConfig.SESSION_SECRET),
        expiresAt: new Date(now.getTime() + token.expiresInSeconds * 1000),
        lastValidatedAt: now,
        refreshStatus: "valid",
        updatedAt: now
      });

      clearCookie(c, botOauthStateCookieName, apiConfig);
      return c.redirect(new URL("/internal/bot-accounts", apiConfig.PUBLIC_WEB_URL).toString());
    } catch {
      return c.json({ error: { code: "twitch_bot_oauth_failed", message: "Twitch bot login failed." } }, 502);
    }
  });

  app.get("/api/internal/chat-assignments", requireAdmin, async (c) => {
    const rows = await c.get("db").select().from(chatAssignments).orderBy(desc(chatAssignments.updatedAt)).limit(200);
    return c.json({ data: rows });
  });

  app.get("/api/internal/rate-limits", requireAdmin, async (c) => {
    const rows = await c.get("db").select().from(rateLimitObservations).orderBy(desc(rateLimitObservations.observedAt)).limit(200);
    return c.json({ data: rows });
  });

  app.get("/api/internal/eventsub-subscriptions", requireAdmin, async (c) => {
    const rows = await c
      .get("db")
      .select()
      .from(eventsubSubscriptions)
      .orderBy(desc(eventsubSubscriptions.updatedAt))
      .limit(500);
    return c.json({ data: rows });
  });

  app.get("/api/internal/privacy-requests", requireAdmin, async (c) => {
    const rows = await c
      .get("db")
      .select({
        request: privacyRequests,
        subjectLogin: twitchUsers.login,
        subjectDisplayName: twitchUsers.displayName
      })
      .from(privacyRequests)
      .leftJoin(twitchUsers, eq(privacyRequests.subjectTwitchUserId, twitchUsers.twitchUserId))
      .orderBy(desc(privacyRequests.requestedAt))
      .limit(200);

    return c.json({
      data: rows.map((row) => ({
        ...serializePrivacyRequest(row.request),
        subjectLogin: row.subjectLogin,
        subjectDisplayName: row.subjectDisplayName
      }))
    });
  });

  app.post("/api/internal/privacy-requests/:requestId/complete", requireAdmin, async (c) => {
    const params = privacyRequestParamSchema.parse(c.req.param());
    const session = await getCurrentSession(c);
    const request = await completePrivacyRequest(c.get("db"), params.requestId, session?.user.appUserId ?? null);

    if (request == null) {
      return c.json({ error: { code: "not_found", message: "Privacy request not found." } }, 404);
    }

    return c.json({ data: serializePrivacyRequest(request) });
  });

  app.get("/api/internal/errors", requireAdmin, async (c) => {
    const rows = await c.get("db").select().from(eventProcessingFailures).orderBy(desc(eventProcessingFailures.createdAt)).limit(200);
    return c.json({ data: rows });
  });

  app.get("/api/private/chatters/:login", requireInternal, async (c) => {
    const params = loginParamSchema.parse(c.req.param());
    const db = c.get("db");
    const [chatter] = await db
      .select()
      .from(twitchUsers)
      .where(eq(twitchUsers.login, params.login.toLowerCase()))
      .limit(1);

    if (chatter == null) {
      return c.json({ error: { code: "not_found", message: "Chatter not found." } }, 404);
    }

    const [summary] = await db
      .select({
        messageCount: sql<number>`count(*)::int`,
        channelCount: sql<number>`count(distinct ${chatMessages.broadcasterUserId})::int`,
        firstMessageAt: sql<Date | null>`min(${chatMessages.receivedAt})`,
        lastMessageAt: sql<Date | null>`max(${chatMessages.receivedAt})`
      })
      .from(chatMessages)
      .where(eq(chatMessages.chatterUserId, chatter.twitchUserId));

    const recentMessages = await db
      .select({
        messageId: chatMessages.twitchMessageId,
        broadcasterUserId: chatMessages.broadcasterUserId,
        broadcasterLogin: twitchUsers.login,
        broadcasterDisplayName: twitchUsers.displayName,
        twitchStreamId: chatMessages.twitchStreamId,
        sentAt: chatMessages.sentAt,
        receivedAt: chatMessages.receivedAt,
        rawText: chatMessages.rawText,
        source: chatMessages.source,
        messageType: chatMessages.messageType
      })
      .from(chatMessages)
      .leftJoin(twitchUsers, eq(chatMessages.broadcasterUserId, twitchUsers.twitchUserId))
      .where(eq(chatMessages.chatterUserId, chatter.twitchUserId))
      .orderBy(desc(chatMessages.receivedAt))
      .limit(500);

    const membershipEvents = await db
      .select({
        id: chatMembershipEvents.id,
        eventType: chatMembershipEvents.eventType,
        source: chatMembershipEvents.source,
        confidence: chatMembershipEvents.confidence,
        broadcasterUserId: chatMembershipEvents.broadcasterUserId,
        broadcasterLogin: twitchUsers.login,
        broadcasterDisplayName: twitchUsers.displayName,
        twitchStreamId: chatMembershipEvents.twitchStreamId,
        eventAt: chatMembershipEvents.eventAt,
        receivedAt: chatMembershipEvents.receivedAt
      })
      .from(chatMembershipEvents)
      .leftJoin(twitchUsers, eq(chatMembershipEvents.broadcasterUserId, twitchUsers.twitchUserId))
      .where(or(eq(chatMembershipEvents.chatterUserId, chatter.twitchUserId), eq(chatMembershipEvents.chatterLogin, chatter.login ?? params.login.toLowerCase())))
      .orderBy(desc(chatMembershipEvents.receivedAt))
      .limit(300);

    const presenceObservations = await db
      .select({
        id: chatPresenceObservations.id,
        broadcasterUserId: chatPresenceObservations.broadcasterUserId,
        broadcasterLogin: twitchUsers.login,
        broadcasterDisplayName: twitchUsers.displayName,
        twitchStreamId: chatPresenceObservations.twitchStreamId,
        observedAt: chatPresenceObservations.observedAt,
        source: chatPresenceObservations.source,
        confidence: chatPresenceObservations.confidence
      })
      .from(chatPresenceObservations)
      .leftJoin(twitchUsers, eq(chatPresenceObservations.broadcasterUserId, twitchUsers.twitchUserId))
      .where(or(eq(chatPresenceObservations.chatterUserId, chatter.twitchUserId), eq(chatPresenceObservations.chatterLogin, chatter.login ?? params.login.toLowerCase())))
      .orderBy(desc(chatPresenceObservations.observedAt))
      .limit(300);

    return c.json({
      data: {
        user: chatter,
        privateMvpProfile: true,
        summary: {
          messageCount: summary?.messageCount ?? 0,
          channelCount: summary?.channelCount ?? 0,
          firstMessageAt: toIso(summary?.firstMessageAt),
          lastMessageAt: toIso(summary?.lastMessageAt)
        },
        recentMessages: recentMessages.map((message) => ({
          ...message,
          sentAt: toIso(message.sentAt),
          receivedAt: message.receivedAt.toISOString()
        })),
        membershipEvents: membershipEvents.map((event) => ({
          ...event,
          eventAt: toIso(event.eventAt),
          receivedAt: event.receivedAt.toISOString()
        })),
        presenceObservations: presenceObservations.map((observation) => ({
          ...observation,
          observedAt: observation.observedAt.toISOString()
        }))
      }
    });
  });

  app.get("/api/private/streams/:streamId/raw", requireInternal, async (c) => {
    const params = streamParamSchema.parse(c.req.param());
    const db = c.get("db");
    const [stream] = await db
      .select({
        twitchStreamId: streamSessions.twitchStreamId,
        broadcasterUserId: streamSessions.broadcasterUserId,
        broadcasterLogin: twitchUsers.login,
        broadcasterDisplayName: twitchUsers.displayName,
        startedAt: streamSessions.startedAt,
        endedAt: streamSessions.endedAt,
        latestTitle: streamSessions.latestTitle,
        latestCategoryName: streamSessions.latestCategoryName,
        language: streamSessions.language
      })
      .from(streamSessions)
      .leftJoin(twitchUsers, eq(streamSessions.broadcasterUserId, twitchUsers.twitchUserId))
      .where(eq(streamSessions.twitchStreamId, params.streamId))
      .limit(1);

    if (stream == null) {
      return c.json({ error: { code: "not_found", message: "Stream not found." } }, 404);
    }

    const messages = await db
      .select({
        messageId: chatMessages.twitchMessageId,
        chatterUserId: chatMessages.chatterUserId,
        chatterLogin: chatMessages.chatterLogin,
        chatterDisplayName: twitchUsers.displayName,
        sentAt: chatMessages.sentAt,
        receivedAt: chatMessages.receivedAt,
        rawText: chatMessages.rawText,
        source: chatMessages.source,
        messageType: chatMessages.messageType,
        rawIrcMessageId: rawIrcMessages.id,
        rawIrcCommand: rawIrcMessages.parsedCommand,
        rawIrcLine: rawIrcMessages.rawLine
      })
      .from(chatMessages)
      .leftJoin(twitchUsers, eq(chatMessages.chatterUserId, twitchUsers.twitchUserId))
      .leftJoin(rawIrcMessages, eq(chatMessages.rawIrcMessageId, rawIrcMessages.id))
      .where(eq(chatMessages.twitchStreamId, params.streamId))
      .orderBy(desc(chatMessages.receivedAt))
      .limit(1000);

    const membershipEvents = await db
      .select({
        id: chatMembershipEvents.id,
        eventType: chatMembershipEvents.eventType,
        source: chatMembershipEvents.source,
        confidence: chatMembershipEvents.confidence,
        chatterUserId: chatMembershipEvents.chatterUserId,
        chatterLogin: chatMembershipEvents.chatterLogin,
        eventAt: chatMembershipEvents.eventAt,
        receivedAt: chatMembershipEvents.receivedAt,
        rawIrcMessageId: rawIrcMessages.id,
        rawIrcCommand: rawIrcMessages.parsedCommand,
        rawIrcLine: rawIrcMessages.rawLine
      })
      .from(chatMembershipEvents)
      .leftJoin(rawIrcMessages, eq(chatMembershipEvents.rawIrcMessageId, rawIrcMessages.id))
      .where(eq(chatMembershipEvents.twitchStreamId, params.streamId))
      .orderBy(desc(chatMembershipEvents.receivedAt))
      .limit(200);

    const presenceSnapshots = await db
      .select({
        id: chatPresenceSnapshots.id,
        source: chatPresenceSnapshots.source,
        confidence: chatPresenceSnapshots.confidence,
        sampledAt: chatPresenceSnapshots.sampledAt,
        chatterCount: chatPresenceSnapshots.chatterCount,
        pageCount: chatPresenceSnapshots.pageCount,
        requestStatus: chatPresenceSnapshots.requestStatus,
        latestError: chatPresenceSnapshots.latestError
      })
      .from(chatPresenceSnapshots)
      .where(eq(chatPresenceSnapshots.twitchStreamId, params.streamId))
      .orderBy(desc(chatPresenceSnapshots.sampledAt))
      .limit(50);

    const presenceObservations = await db
      .select({
        id: chatPresenceObservations.id,
        chatterUserId: chatPresenceObservations.chatterUserId,
        chatterLogin: chatPresenceObservations.chatterLogin,
        chatterDisplayName: chatPresenceObservations.chatterDisplayName,
        observedAt: chatPresenceObservations.observedAt,
        source: chatPresenceObservations.source,
        confidence: chatPresenceObservations.confidence
      })
      .from(chatPresenceObservations)
      .where(eq(chatPresenceObservations.twitchStreamId, params.streamId))
      .orderBy(desc(chatPresenceObservations.observedAt))
      .limit(500);

    const events = await db
      .select({
        id: channelEvents.id,
        eventType: channelEvents.eventType,
        actorUserId: channelEvents.actorUserId,
        occurredAt: channelEvents.occurredAt,
        source: channelEvents.source,
        sourceEventId: channelEvents.sourceEventId,
        rawEventsubEventId: rawEventsubEvents.id,
        rawEventsubPayload: rawEventsubEvents.payload
      })
      .from(channelEvents)
      .leftJoin(rawEventsubEvents, eq(channelEvents.rawEventsubEventId, rawEventsubEvents.id))
      .where(eq(channelEvents.twitchStreamId, params.streamId))
      .orderBy(desc(channelEvents.occurredAt))
      .limit(100);

    return c.json({
      data: {
        stream: {
          ...stream,
          startedAt: stream.startedAt.toISOString(),
          endedAt: toIso(stream.endedAt)
        },
        messages: messages.map((message) => ({
          ...message,
          sentAt: toIso(message.sentAt),
          receivedAt: message.receivedAt.toISOString()
        })),
        membershipEvents: membershipEvents.map((event) => ({
          ...event,
          eventAt: toIso(event.eventAt),
          receivedAt: event.receivedAt.toISOString()
        })),
        presenceSnapshots: presenceSnapshots.map((snapshot) => ({
          ...snapshot,
          sampledAt: snapshot.sampledAt.toISOString()
        })),
        presenceObservations: presenceObservations.map((observation) => ({
          ...observation,
          observedAt: observation.observedAt.toISOString()
        })),
        events: events.map((event) => ({
          ...event,
          occurredAt: event.occurredAt.toISOString()
        }))
      }
    });
  });

  app.post("/api/webhooks/twitch/eventsub", async (c) => {
    const rawBody = await c.req.text();
    const payload = JSON.parse(rawBody) as unknown;
    const headers = c.req.raw.headers;
    const signature = headers.get(eventSubHeaders.messageSignature);
    const messageId = headers.get(eventSubHeaders.messageId);
    const messageTimestamp = headers.get(eventSubHeaders.messageTimestamp);

    if (signature == null || messageId == null || messageTimestamp == null) {
      return c.json({ error: { code: "missing_signature_headers", message: "EventSub signature headers are required." } }, 403);
    }

    const verified = verifyEventSubSignature({
      secret: c.get("config").TWITCH_EVENTSUB_SECRET,
      messageId,
      messageTimestamp,
      rawBody,
      signature
    });
    if (!verified) {
      return c.json({ error: { code: "invalid_signature", message: "EventSub signature validation failed." } }, 403);
    }

    const envelope = createEventSubEnvelope(headers, payload);
    await c
      .get("db")
      .insert(rawEventsubEvents)
      .values({
        twitchMessageId: envelope.messageId,
        twitchEventId: extractEventId(payload),
        subscriptionId: extractSubscriptionId(payload),
        eventType: envelope.subscriptionType ?? "unknown",
        eventVersion: envelope.subscriptionVersion,
        payload,
        receivedAt: envelope.receivedAt,
        processingStatus: envelope.messageType === "webhook_callback_verification" ? "ignored" : "pending"
      })
      .onConflictDoNothing({
        target: rawEventsubEvents.twitchMessageId
      });

    if (envelope.messageType === "webhook_callback_verification" && isChallengePayload(payload)) {
      return c.text(payload.challenge);
    }

    return c.json({ data: { accepted: true, messageId: envelope.messageId } }, 202);
  });

  return app;
};

type RouteContext = Parameters<MiddlewareHandler<ApiBindings>>[0];
type PrivacyRequestRow = typeof privacyRequests.$inferSelect;
type SubjectPrivacyStateRow = typeof subjectPrivacyStates.$inferSelect;

const readRequestBody = async (c: RouteContext): Promise<unknown> => {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return c.req.json();
  }

  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    return c.req.parseBody();
  }

  return {};
};

const getSubjectPrivacyState = async (db: DbClient, twitchUserId: string): Promise<SubjectPrivacyStateRow | null> => {
  const [state] = await db
    .select()
    .from(subjectPrivacyStates)
    .where(eq(subjectPrivacyStates.twitchUserId, twitchUserId))
    .limit(1);

  return state ?? null;
};

const serializeSubjectPrivacyState = (state: SubjectPrivacyStateRow | null) => {
  return {
    publicProfileHidden: state?.publicProfileHidden ?? false,
    trackingOptedOut: state?.trackingOptedOut ?? false,
    rawDataRedactedAt: toIso(state?.rawDataRedactedAt),
    dataDeletedAt: toIso(state?.dataDeletedAt),
    latestRequestId: state?.latestRequestId ?? null
  };
};

const serializePrivacyRequest = (request: PrivacyRequestRow) => {
  return {
    id: request.id,
    requestType: request.requestType,
    status: request.status,
    subjectTwitchUserId: request.subjectTwitchUserId,
    requestedAt: request.requestedAt.toISOString(),
    resolvedAt: toIso(request.resolvedAt),
    latestError: request.latestError,
    details: request.details
  };
};

const isSubjectSuppressed = (state: { publicProfileHidden: boolean | null; trackingOptedOut: boolean | null }) => {
  return state.publicProfileHidden === true || state.trackingOptedOut === true;
};

const completePrivacyRequest = async (
  db: DbClient,
  requestId: string,
  actorAppUserId: string | null
): Promise<PrivacyRequestRow | null> => {
  const [request] = await db.select().from(privacyRequests).where(eq(privacyRequests.id, requestId)).limit(1);
  if (request == null) {
    return null;
  }

  if (request.status === "completed") {
    return request;
  }

  const now = new Date();
  await applyPrivacyRequestEffects(db, request, now);

  const [updated] = await db
    .update(privacyRequests)
    .set({
      status: "completed",
      reviewedByAppUserId: actorAppUserId,
      resolvedAt: now,
      latestError: null,
      updatedAt: now
    })
    .where(eq(privacyRequests.id, request.id))
    .returning();

  await db.insert(privacyRequestEvents).values({
    privacyRequestId: request.id,
    eventType: "completed",
    actorAppUserId,
    details: {},
    occurredAt: now
  });

  return updated ?? request;
};

const applyPrivacyRequestEffects = async (db: DbClient, request: PrivacyRequestRow, now: Date) => {
  if (request.requestType === "public_profile_opt_out") {
    await upsertSubjectPrivacyState(db, request.subjectTwitchUserId, {
      publicProfileHidden: true,
      latestRequestId: request.id,
      updatedAt: now
    });
    return;
  }

  if (request.requestType === "tracking_opt_out") {
    await upsertSubjectPrivacyState(db, request.subjectTwitchUserId, {
      publicProfileHidden: true,
      trackingOptedOut: true,
      latestRequestId: request.id,
      updatedAt: now
    });
    await closeSubjectAssignments(db, request.subjectTwitchUserId);
    return;
  }

  await redactSubjectData(db, request.subjectTwitchUserId);
  await upsertSubjectPrivacyState(db, request.subjectTwitchUserId, {
    publicProfileHidden: true,
    trackingOptedOut: true,
    rawDataRedactedAt: now,
    dataDeletedAt: now,
    latestRequestId: request.id,
    updatedAt: now
  });
  await closeSubjectAssignments(db, request.subjectTwitchUserId);
};

const upsertSubjectPrivacyState = async (
  db: DbClient,
  twitchUserId: string,
  set: Partial<typeof subjectPrivacyStates.$inferInsert>
) => {
  await db
    .insert(subjectPrivacyStates)
    .values({
      twitchUserId,
      publicProfileHidden: set.publicProfileHidden ?? false,
      trackingOptedOut: set.trackingOptedOut ?? false,
      rawDataRedactedAt: set.rawDataRedactedAt,
      dataDeletedAt: set.dataDeletedAt,
      latestRequestId: set.latestRequestId,
      updatedAt: set.updatedAt
    })
    .onConflictDoUpdate({
      target: subjectPrivacyStates.twitchUserId,
      set
    });
};

const closeSubjectAssignments = async (db: DbClient, twitchUserId: string) => {
  await db.execute(sql`
    with closed as (
      update chat_assignments
      set status = 'left',
          left_at = coalesce(left_at, now()),
          latest_error = null,
          updated_at = now()
      where broadcaster_user_id = ${twitchUserId}
        and status in ('desired', 'joining', 'joined', 'leaving')
      returning id
    )
    insert into chat_assignment_events (
      chat_assignment_id,
      event_type,
      reason,
      details,
      occurred_at,
      created_at,
      updated_at
    )
    select
      id,
      'left',
      'subject tracking opt-out',
      jsonb_build_object('source', 'privacy_request'),
      now(),
      now(),
      now()
    from closed
  `);
};

const redactSubjectData = async (db: DbClient, twitchUserId: string) => {
  const [subject] = await db
    .select({ login: twitchUsers.login })
    .from(twitchUsers)
    .where(eq(twitchUsers.twitchUserId, twitchUserId))
    .limit(1);
  const subjectLogin = subject?.login ?? "";

  await db.execute(sql`
    with linked_raw_irc as (
      select raw_irc_message_id as id
      from chat_messages
      where raw_irc_message_id is not null
        and (chatter_user_id = ${twitchUserId} or (${subjectLogin} <> '' and chatter_login = ${subjectLogin}))
      union
      select raw_irc_message_id as id
      from chat_membership_events
      where raw_irc_message_id is not null
        and (chatter_user_id = ${twitchUserId} or (${subjectLogin} <> '' and chatter_login = ${subjectLogin}))
    ),
    linked_raw_eventsub as (
      select raw_eventsub_event_id as id
      from chat_messages
      where raw_eventsub_event_id is not null
        and (chatter_user_id = ${twitchUserId} or (${subjectLogin} <> '' and chatter_login = ${subjectLogin}))
      union
      select raw_eventsub_event_id as id
      from channel_events
      where raw_eventsub_event_id is not null
        and actor_user_id = ${twitchUserId}
    ),
    redacted_irc as (
      update raw_irc_messages
      set raw_line = '[redacted by subject data deletion]',
          tags = '{}'::jsonb,
          parse_error = null,
          updated_at = now()
      where id in (select id from linked_raw_irc)
      returning 1
    ),
    redacted_eventsub as (
      update raw_eventsub_events
      set payload = jsonb_build_object('redacted', true, 'reason', 'subject_data_deletion', 'event_type', event_type),
          updated_at = now()
      where id in (select id from linked_raw_eventsub)
      returning 1
    ),
    redacted_messages as (
      update chat_messages
      set chatter_user_id = null,
          chatter_login = null,
          raw_text = null,
          badges = '{}'::jsonb,
          emotes = '{}'::jsonb,
          updated_at = now()
      where chatter_user_id = ${twitchUserId}
        or (${subjectLogin} <> '' and chatter_login = ${subjectLogin})
      returning 1
    ),
    redacted_membership as (
      update chat_membership_events
      set chatter_user_id = null,
          chatter_login = null,
          updated_at = now()
      where chatter_user_id = ${twitchUserId}
        or (${subjectLogin} <> '' and chatter_login = ${subjectLogin})
      returning 1
    ),
    redacted_presence as (
      update chat_presence_observations
      set chatter_user_id = null,
          chatter_login = null,
          chatter_display_name = null,
          updated_at = now()
      where chatter_user_id = ${twitchUserId}
        or (${subjectLogin} <> '' and chatter_login = ${subjectLogin})
      returning 1
    ),
    redacted_channel_events as (
      update channel_events
      set actor_user_id = null,
          updated_at = now()
      where actor_user_id = ${twitchUserId}
      returning 1
    ),
    redacted_raids as (
      update raids
      set source_broadcaster_user_id = case when source_broadcaster_user_id = ${twitchUserId} then null else source_broadcaster_user_id end,
          target_broadcaster_user_id = case when target_broadcaster_user_id = ${twitchUserId} then null else target_broadcaster_user_id end,
          updated_at = now()
      where source_broadcaster_user_id = ${twitchUserId}
         or target_broadcaster_user_id = ${twitchUserId}
      returning 1
    ),
    deleted_chatter_channel_buckets as (
      delete from chatter_channel_activity_buckets
      where chatter_user_id = ${twitchUserId}
      returning 1
    ),
    deleted_chatter_daily_stats as (
      delete from chatter_daily_stats
      where chatter_user_id = ${twitchUserId}
      returning 1
    ),
    revoked_sessions as (
      update sessions
      set revoked_at = coalesce(revoked_at, now()),
          updated_at = now()
      where app_user_id in (select id from app_users where twitch_user_id = ${twitchUserId})
      returning 1
    ),
    redacted_oauth as (
      update oauth_accounts
      set encrypted_access_token = null,
          encrypted_refresh_token = null,
          refresh_status = 'deleted_by_subject_request',
          latest_error = null,
          updated_at = now()
      where app_user_id in (select id from app_users where twitch_user_id = ${twitchUserId})
      returning 1
    )
    update twitch_users
    set description = null,
        profile_image_url = null,
        offline_image_url = null,
        updated_at = now()
    where twitch_user_id = ${twitchUserId}
  `);
};

const requireInternal: MiddlewareHandler<ApiBindings> = async (c, next) => {
  if (!(await hasPrivilegedAccess(c))) {
    return c.json({ error: { code: "forbidden", message: "Internal endpoint is not public." } }, 403);
  }

  await next();
};

const requireAdmin: MiddlewareHandler<ApiBindings> = async (c, next) => {
  if (!(await hasAdminAccess(c))) {
    return c.json({ error: { code: "forbidden", message: "Admin login is required." } }, 403);
  }

  await next();
};

const isInternalAllowed = (config: AppConfig) => {
  return config.APP_MODE === "local" || config.APP_MODE === "private_mvp";
};

const hasAdminAccess = async (c: Parameters<MiddlewareHandler<ApiBindings>>[0]): Promise<boolean> => {
  return (await getCurrentSession(c))?.user.isAdmin === true;
};

const hasPrivilegedAccess = async (c: Parameters<MiddlewareHandler<ApiBindings>>[0]): Promise<boolean> => {
  if (isInternalAllowed(c.get("config"))) {
    return true;
  }

  const session = await getCurrentSession(c);
  return session?.user.isAdmin === true;
};

type CurrentSession = {
  sessionIdHash: string;
  user: {
    appUserId: string;
    twitchUserId: string;
    login: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
    isAdmin: boolean;
  };
};

const getCurrentSession = async (c: Parameters<MiddlewareHandler<ApiBindings>>[0]): Promise<CurrentSession | null> => {
  const sessionToken = getCookie(c, sessionCookieName);
  if (sessionToken == null || sessionToken === "") {
    return null;
  }

  const apiConfig = c.get("config");
  const db = c.get("db");
  const sessionIdHash = hashSessionToken(sessionToken, apiConfig.SESSION_SECRET);
  const [row] = await db
    .select({
      sessionIdHash: sessions.sessionIdHash,
      appUserId: appUsers.id,
      twitchUserId: twitchUsers.twitchUserId,
      login: twitchUsers.login,
      displayName: twitchUsers.displayName,
      profileImageUrl: twitchUsers.profileImageUrl,
      isAdmin: appUsers.isAdmin,
      adminUserId: adminUsers.twitchUserId,
      oauthAccountId: oauthAccounts.id,
      encryptedAccessToken: oauthAccounts.encryptedAccessToken,
      encryptedRefreshToken: oauthAccounts.encryptedRefreshToken,
      tokenExpiresAt: oauthAccounts.expiresAt,
      tokenLastValidatedAt: oauthAccounts.lastValidatedAt
    })
    .from(sessions)
    .innerJoin(appUsers, eq(sessions.appUserId, appUsers.id))
    .innerJoin(twitchUsers, eq(appUsers.twitchUserId, twitchUsers.twitchUserId))
    .leftJoin(adminUsers, eq(appUsers.twitchUserId, adminUsers.twitchUserId))
    .leftJoin(oauthAccounts, and(eq(oauthAccounts.appUserId, appUsers.id), eq(oauthAccounts.provider, "twitch")))
    .where(and(eq(sessions.sessionIdHash, sessionIdHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (row == null) {
    return null;
  }

  const twitchSessionIsValid = await ensureTwitchSessionToken(db, apiConfig, {
    oauthAccountId: row.oauthAccountId,
    encryptedAccessToken: row.encryptedAccessToken,
    encryptedRefreshToken: row.encryptedRefreshToken,
    expiresAt: row.tokenExpiresAt,
    lastValidatedAt: row.tokenLastValidatedAt,
    twitchUserId: row.twitchUserId
  });
  if (!twitchSessionIsValid) {
    const now = new Date();
    await db
      .update(sessions)
      .set({ revokedAt: now, updatedAt: now })
      .where(eq(sessions.sessionIdHash, sessionIdHash));
    clearCookie(c, sessionCookieName, apiConfig);
    return null;
  }

  await db
    .update(sessions)
    .set({ lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(sessions.sessionIdHash, sessionIdHash));

  return {
    sessionIdHash,
    user: {
      appUserId: row.appUserId,
      twitchUserId: row.twitchUserId,
      login: row.login,
      displayName: row.displayName,
      profileImageUrl: row.profileImageUrl,
      isAdmin: row.isAdmin || row.adminUserId != null || parseDelimitedList(apiConfig.ADMIN_TWITCH_USER_IDS).includes(row.twitchUserId)
    }
  };
};

const ensureTwitchSessionToken = async (
  db: DbClient,
  config: AppConfig,
  token: {
    oauthAccountId: string | null;
    encryptedAccessToken: string | null;
    encryptedRefreshToken: string | null;
    expiresAt: Date | null;
    lastValidatedAt: Date | null;
    twitchUserId: string;
  }
): Promise<boolean> => {
  if (token.oauthAccountId == null || token.encryptedAccessToken == null) {
    return false;
  }

  const now = new Date();
  const validationIsFresh = token.lastValidatedAt != null
    && now.getTime() - token.lastValidatedAt.getTime() < twitchTokenValidationIntervalMs;
  const tokenIsCurrent = token.expiresAt == null || token.expiresAt > now;
  if (validationIsFresh && tokenIsCurrent) {
    return true;
  }

  try {
    let accessToken = decryptSecret(token.encryptedAccessToken, config.SESSION_SECRET);
    let encryptedAccessToken = token.encryptedAccessToken;
    let encryptedRefreshToken = token.encryptedRefreshToken;
    let refreshStatus = "valid";

    if (!tokenIsCurrent) {
      if (
        encryptedRefreshToken == null ||
        config.TWITCH_CLIENT_ID === "" ||
        config.TWITCH_CLIENT_SECRET === ""
      ) {
        throw new Error("Twitch login token cannot be refreshed.");
      }

      const refreshed = await refreshTwitchUserAccessToken({
        clientId: config.TWITCH_CLIENT_ID,
        clientSecret: config.TWITCH_CLIENT_SECRET,
        refreshToken: decryptSecret(encryptedRefreshToken, config.SESSION_SECRET)
      });
      accessToken = refreshed.accessToken;
      encryptedAccessToken = encryptSecret(refreshed.accessToken, config.SESSION_SECRET);
      encryptedRefreshToken = refreshed.refreshToken == null
        ? encryptedRefreshToken
        : encryptSecret(refreshed.refreshToken, config.SESSION_SECRET);
      refreshStatus = "refreshed";
    }

    const validation = await validateTwitchAccessToken(accessToken);
    if (validation.clientId !== config.TWITCH_CLIENT_ID || validation.userId !== token.twitchUserId) {
      throw new Error("Twitch login token identity changed.");
    }

    await db
      .update(oauthAccounts)
      .set({
        scopes: validation.scopes,
        encryptedAccessToken,
        encryptedRefreshToken,
        expiresAt: new Date(now.getTime() + validation.expiresInSeconds * 1000),
        lastValidatedAt: now,
        refreshStatus,
        latestError: null,
        updatedAt: now
      })
      .where(eq(oauthAccounts.id, token.oauthAccountId));
    return true;
  } catch {
    await db
      .update(oauthAccounts)
      .set({
        refreshStatus: "validation_failed",
        latestError: "Twitch login validation failed.",
        updatedAt: now
      })
      .where(eq(oauthAccounts.id, token.oauthAccountId));
    return false;
  }
};

type ConfiguredTwitchLogin = AppConfig & {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TWITCH_OAUTH_REDIRECT_URI: string;
};

const isTwitchLoginConfigured = (config: AppConfig): config is ConfiguredTwitchLogin => {
  return config.TWITCH_CLIENT_ID !== ""
    && config.TWITCH_CLIENT_SECRET !== ""
    && config.TWITCH_OAUTH_REDIRECT_URI != null
    && config.TWITCH_OAUTH_REDIRECT_URI !== "";
};

const persistConfiguredAdminGrant = async (
  db: DbClient,
  config: AppConfig,
  user: { twitchUserId: string; login: string },
  now: Date
) => {
  const normalizedLogin = user.login.toLowerCase();
  const configuredLogin = parseDelimitedList(config.ADMIN_TWITCH_LOGINS)
    .map((login) => login.toLowerCase())
    .find((login) => login === normalizedLogin);
  if (configuredLogin == null) {
    return;
  }

  const grantSource = `configured-login:${configuredLogin}`;
  const [existingGrant] = await db
    .select({ twitchUserId: adminUsers.twitchUserId })
    .from(adminUsers)
    .where(eq(adminUsers.grantedBy, grantSource))
    .limit(1);
  if (existingGrant != null && existingGrant.twitchUserId !== user.twitchUserId) {
    return;
  }

  await db
    .insert(adminUsers)
    .values({
      twitchUserId: user.twitchUserId,
      grantedBy: grantSource,
      grantedAt: now,
      updatedAt: now
    })
    .onConflictDoNothing({ target: adminUsers.twitchUserId });
};

const redirectToOwnData = (c: RouteContext, authStatus: string) => {
  const url = new URL("/me", c.get("config").PUBLIC_WEB_URL);
  url.searchParams.set("auth", authStatus);
  return c.redirect(url.toString());
};

const parseDelimitedList = (value: string): string[] => {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const escapeLikePattern = (value: string): string => {
  return value.replace(/[\\%_]/g, "\\$&");
};

const toIso = (value: Date | null | undefined): string | null => {
  return value == null ? null : value.toISOString();
};

const rankChatAssignmentStatus = (status: string): number => {
  switch (status) {
    case "joined":
      return 4;
    case "joining":
      return 3;
    case "desired":
      return 2;
    case "leaving":
      return 1;
    default:
      return 0;
  }
};

const isActiveChatAssignmentStatus = (status: string): status is ActiveChatAssignmentStatus => {
  return activeChatAssignmentStatuses.includes(status as ActiveChatAssignmentStatus);
};

const uniqueByStreamId = <T extends { streamId: string }>(rows: T[]): T[] => {
  const seen = new Set<string>();
  const uniqueRows: T[] = [];
  for (const row of rows) {
    if (seen.has(row.streamId)) {
      continue;
    }

    seen.add(row.streamId);
    uniqueRows.push(row);
  }

  return uniqueRows;
};

const clearCookie = (c: Parameters<MiddlewareHandler<ApiBindings>>[0], name: string, config: AppConfig) => {
  setCookie(c, name, "", {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "Lax",
    path: "/",
    maxAge: 0
  });
};

const isChallengePayload = (payload: unknown): payload is { challenge: string } => {
  return typeof payload === "object" && payload != null && "challenge" in payload && typeof (payload as { challenge: unknown }).challenge === "string";
};

const extractSubscriptionId = (payload: unknown): string | null => {
  if (typeof payload !== "object" || payload == null || !("subscription" in payload)) {
    return null;
  }

  const subscription = (payload as { subscription?: unknown }).subscription;
  if (typeof subscription !== "object" || subscription == null || !("id" in subscription)) {
    return null;
  }

  const id = (subscription as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
};

const extractEventId = (payload: unknown): string | null => {
  if (typeof payload !== "object" || payload == null || !("event" in payload)) {
    return null;
  }

  const event = (payload as { event?: unknown }).event;
  if (typeof event !== "object" || event == null || !("id" in event)) {
    return null;
  }

  const id = (event as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
};
