import {
  channelEvents,
  channels,
  closeSupersededLiveStreamSessions,
  eventProcessingFailures,
  eventsubSubscriptions,
  raids,
  rawEventsubEvents,
  streamSessions,
  streamSnapshots,
  subjectPrivacyStates,
  twitchUsers
} from "@twitch-tracker/db";
import {
  FetchEventSubAdapter,
  getTwitchAppAccessToken,
  TwitchEventSubApiError,
  type EventSubSubscription
} from "@twitch-tracker/twitch";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  hasEquivalentEventSubSubscription,
  planEventSubReconciliation,
  selectDesiredEventSubChannelIds,
  type DesiredEventSubSubscription
} from "../eventsub-reconciliation.js";
import { getFinnishStreamMatchReason } from "../finnish-stream.js";
import type { WorkerContext } from "../worker.js";
import { startIntervalLoop } from "./common.js";

type DesiredSubscription = DesiredEventSubSubscription & {
  type: string;
  version: string;
  condition: Record<string, string>;
  broadcasterUserId: string;
  callbackUrl: string;
};

type RawEventSubRow = typeof rawEventsubEvents.$inferSelect;

const streamOnlinePayloadSchema = z.object({
  event: z.object({
    id: z.string().min(1),
    broadcaster_user_id: z.string().min(1),
    broadcaster_user_login: z.string().nullish(),
    broadcaster_user_name: z.string().nullish(),
    type: z.string().nullish(),
    started_at: z.string().min(1)
  })
});

const streamOfflinePayloadSchema = z.object({
  event: z.object({
    id: z.string().min(1),
    broadcaster_user_id: z.string().min(1),
    broadcaster_user_login: z.string().nullish(),
    broadcaster_user_name: z.string().nullish()
  })
});

const channelUpdatePayloadSchema = z.object({
  event: z.object({
    broadcaster_user_id: z.string().min(1),
    broadcaster_user_login: z.string().nullish(),
    broadcaster_user_name: z.string().nullish(),
    title: z.string().nullish(),
    language: z.string().nullish(),
    category_id: z.string().nullish(),
    category_name: z.string().nullish()
  })
});

const channelRaidPayloadSchema = z.object({
  event: z.object({
    from_broadcaster_user_id: z.string().min(1),
    from_broadcaster_user_login: z.string().nullish(),
    from_broadcaster_user_name: z.string().nullish(),
    to_broadcaster_user_id: z.string().min(1),
    to_broadcaster_user_login: z.string().nullish(),
    to_broadcaster_user_name: z.string().nullish(),
    viewers: z.number().int().nonnegative().nullish()
  })
});

const genericEventSubPayloadSchema = z.object({
  event: z.record(z.string(), z.unknown())
});

const eventSubRevocationPayloadSchema = z.object({
  subscription: z.object({
    id: z.string().min(1),
    status: z.string().min(1)
  })
});

export const runEventSubProcessingLoop = (context: WorkerContext) => {
  return startIntervalLoop({
    name: "eventsub",
    intervalMs: context.config.EVENTSUB_PROCESSING_INTERVAL_MS,
    context,
    run: () => processPendingEventSubEvents(context)
  });
};

export const runEventSubReconciliationLoop = (context: WorkerContext) => {
  return startIntervalLoop({
    name: "eventsub-reconciliation",
    intervalMs: context.config.EVENTSUB_RECONCILIATION_INTERVAL_MS,
    context,
    run: () => reconcileSubscriptions(context)
  });
};

const processPendingEventSubEvents = async (context: WorkerContext) => {
  const rows = await context.db
    .select()
    .from(rawEventsubEvents)
    .where(eq(rawEventsubEvents.processingStatus, "pending"))
    .orderBy(rawEventsubEvents.receivedAt)
    .limit(100);

  let processedEvents = 0;
  let ignoredEvents = 0;
  let failedEvents = 0;

  for (const row of rows) {
    try {
      const outcome = await processRawEventSubEvent(context, row);
      if (outcome === "processed") {
        processedEvents += 1;
      } else {
        ignoredEvents += 1;
      }
    } catch (error) {
      failedEvents += 1;
      await markEventSubFailed(context, row, error);
    }
  }

  return {
    pendingEventsSeen: rows.length,
    processedEvents,
    ignoredEvents,
    failedEvents
  };
};

const processRawEventSubEvent = async (context: WorkerContext, row: RawEventSubRow): Promise<"processed" | "ignored"> => {
  if (row.messageType === "revocation") {
    const parsed = eventSubRevocationPayloadSchema.parse(row.payload);
    await context.db
      .update(eventsubSubscriptions)
      .set({
        twitchSubscriptionId: null,
        status: parsed.subscription.status,
        cost: null,
        lastSyncedAt: row.receivedAt,
        latestError: `Revoked by Twitch: ${parsed.subscription.status}`,
        updatedAt: row.receivedAt
      })
      .where(eq(eventsubSubscriptions.twitchSubscriptionId, parsed.subscription.id));
    await markEventSubProcessed(context, row);
    return "processed";
  }
  if (row.messageType != null && row.messageType !== "notification") {
    await context.db
      .update(rawEventsubEvents)
      .set({
        processingStatus: "ignored",
        errorMessage: `Unsupported EventSub message type: ${row.messageType}`,
        updatedAt: new Date()
      })
      .where(eq(rawEventsubEvents.id, row.id));
    return "ignored";
  }

  switch (row.eventType) {
    case "stream.online":
      await processStreamOnline(context, row);
      await markEventSubProcessed(context, row);
      return "processed";
    case "stream.offline":
      await processStreamOffline(context, row);
      await markEventSubProcessed(context, row);
      return "processed";
    case "channel.update":
      await processChannelUpdate(context, row);
      await markEventSubProcessed(context, row);
      return "processed";
    case "channel.raid":
      await processChannelRaid(context, row);
      await markEventSubProcessed(context, row);
      return "processed";
    case "channel.shared_chat.begin":
    case "channel.shared_chat.update":
    case "channel.shared_chat.end":
      await processGenericChannelEvent(context, row, "shared_chat_id");
      await markEventSubProcessed(context, row);
      return "processed";
    case "user.update":
      await processUserUpdate(context, row);
      await markEventSubProcessed(context, row);
      return "processed";
    default:
      await context.db
        .update(rawEventsubEvents)
        .set({
          processingStatus: "ignored",
          errorMessage: `Unsupported EventSub event type: ${row.eventType}`,
          updatedAt: new Date()
        })
        .where(eq(rawEventsubEvents.id, row.id));
      return "ignored";
  }
};

const processUserUpdate = async (context: WorkerContext, row: RawEventSubRow) => {
  const parsed = genericEventSubPayloadSchema.parse(row.payload);
  const event = parsed.event;
  const userId = readEventString(event, "user_id");
  if (userId == null) {
    throw new Error("user.update payload is missing user_id.");
  }

  await upsertTwitchUser(context, {
    userId,
    login: readEventString(event, "user_login"),
    displayName: readEventString(event, "user_name")
  });
  await ensureTrackedChannel(context, userId);

  await insertChannelEvent(context, {
    eventType: "user.update",
    broadcasterUserId: userId,
    twitchStreamId: await findLiveStreamId(context, userId),
    actorUserId: userId,
    occurredAt: row.receivedAt,
    sourceEventId: sourceEventId(row),
    rawEventsubEventId: row.id
  });
};

const processGenericChannelEvent = async (context: WorkerContext, row: RawEventSubRow, preferredSourceField: string) => {
  const parsed = genericEventSubPayloadSchema.parse(row.payload);
  const event = parsed.event;
  const broadcasterUserId = readEventString(event, "broadcaster_user_id");
  if (broadcasterUserId == null) {
    throw new Error(`${row.eventType} payload is missing broadcaster_user_id.`);
  }

  await upsertTwitchUser(context, {
    userId: broadcasterUserId,
    login: readEventString(event, "broadcaster_user_login"),
    displayName: readEventString(event, "broadcaster_user_name")
  });
  await ensureTrackedChannel(context, broadcasterUserId);

  await insertChannelEvent(context, {
    eventType: row.eventType,
    broadcasterUserId,
    twitchStreamId: await findLiveStreamId(context, broadcasterUserId),
    actorUserId: null,
    occurredAt: row.receivedAt,
    sourceEventId: readEventString(event, preferredSourceField) ?? sourceEventId(row),
    rawEventsubEventId: row.id
  });
};

const processStreamOnline = async (context: WorkerContext, row: RawEventSubRow) => {
  const parsed = streamOnlinePayloadSchema.parse(row.payload);
  const event = parsed.event;
  const startedAt = parseEventDate(event.started_at);
  const receivedAt = row.receivedAt;

  await upsertTwitchUser(context, {
    userId: event.broadcaster_user_id,
    login: event.broadcaster_user_login,
    displayName: event.broadcaster_user_name
  });
  await ensureTrackedChannel(context, event.broadcaster_user_id);

  await closeSupersededLiveStreamSessions(context.db, {
    broadcasterUserId: event.broadcaster_user_id,
    currentStreamId: event.id,
    observedAt: receivedAt,
    source: "eventsub.stream.online.superseded"
  });

  await context.db
    .insert(streamSessions)
    .values({
      twitchStreamId: event.id,
      broadcasterUserId: event.broadcaster_user_id,
      startedAt,
      firstSeenAt: receivedAt,
      lastSeenLiveAt: receivedAt,
      endDetectionSource: null
    })
    .onConflictDoUpdate({
      target: streamSessions.twitchStreamId,
      set: {
        broadcasterUserId: event.broadcaster_user_id,
        startedAt,
        endedAt: null,
        lastSeenLiveAt: receivedAt,
        endDetectionSource: null,
        updatedAt: new Date()
      }
    });

  await insertChannelEvent(context, {
    eventType: "stream.online",
    broadcasterUserId: event.broadcaster_user_id,
    twitchStreamId: event.id,
    actorUserId: null,
    occurredAt: startedAt,
    sourceEventId: sourceEventId(row),
    rawEventsubEventId: row.id
  });
};

const processStreamOffline = async (context: WorkerContext, row: RawEventSubRow) => {
  const parsed = streamOfflinePayloadSchema.parse(row.payload);
  const event = parsed.event;
  const occurredAt = row.receivedAt;

  await upsertTwitchUser(context, {
    userId: event.broadcaster_user_id,
    login: event.broadcaster_user_login,
    displayName: event.broadcaster_user_name
  });
  await ensureTrackedChannel(context, event.broadcaster_user_id);

  const twitchStreamId = await findStreamForOfflineEvent(context, event.id, event.broadcaster_user_id);
  if (twitchStreamId != null) {
    await context.db
      .update(streamSessions)
      .set({
        endedAt: occurredAt,
        endDetectionSource: "eventsub.stream.offline",
        updatedAt: new Date()
      })
      .where(eq(streamSessions.twitchStreamId, twitchStreamId));
  }

  await insertChannelEvent(context, {
    eventType: "stream.offline",
    broadcasterUserId: event.broadcaster_user_id,
    twitchStreamId,
    actorUserId: null,
    occurredAt,
    sourceEventId: sourceEventId(row),
    rawEventsubEventId: row.id
  });
};

const processChannelUpdate = async (context: WorkerContext, row: RawEventSubRow) => {
  const parsed = channelUpdatePayloadSchema.parse(row.payload);
  const event = parsed.event;
  const occurredAt = row.receivedAt;

  await upsertTwitchUser(context, {
    userId: event.broadcaster_user_id,
    login: event.broadcaster_user_login,
    displayName: event.broadcaster_user_name
  });
  await ensureTrackedChannel(context, event.broadcaster_user_id);

  const liveStreamId = await findLiveStreamId(context, event.broadcaster_user_id);
  if (liveStreamId != null) {
    const [eligibility] = await context.db
      .select({
        existingMatchReason: streamSessions.finnishMatchReason,
        isManuallyPinned: channels.isManuallyPinned
      })
      .from(streamSessions)
      .leftJoin(channels, eq(streamSessions.broadcasterUserId, channels.twitchUserId))
      .where(eq(streamSessions.twitchStreamId, liveStreamId))
      .limit(1);
    const [latestMetadata] = await context.db
      .select({ tags: streamSnapshots.tags })
      .from(streamSnapshots)
      .where(and(
        eq(streamSnapshots.twitchStreamId, liveStreamId),
        isNotNull(streamSnapshots.title)
      ))
      .orderBy(desc(streamSnapshots.observedAt), desc(streamSnapshots.id))
      .limit(1);
    const finnishMatchReason = getFinnishStreamMatchReason({
      language: event.language,
      tags: latestMetadata?.tags,
      manuallyPinned: eligibility?.isManuallyPinned ?? false
    });
    await context.db
      .update(streamSessions)
      .set({
        latestTitle: event.title ?? null,
        language: event.language ?? null,
        finnishMatchReason: finnishMatchReason ?? eligibility?.existingMatchReason ?? null,
        isFinnishEligible: finnishMatchReason != null,
        latestCategoryId: event.category_id ?? null,
        latestCategoryName: event.category_name ?? null,
        updatedAt: new Date()
      })
      .where(eq(streamSessions.twitchStreamId, liveStreamId));
  }

  await insertChannelEvent(context, {
    eventType: "channel.update",
    broadcasterUserId: event.broadcaster_user_id,
    twitchStreamId: liveStreamId,
    actorUserId: null,
    occurredAt,
    sourceEventId: sourceEventId(row),
    rawEventsubEventId: row.id
  });
};

const processChannelRaid = async (context: WorkerContext, row: RawEventSubRow) => {
  const parsed = channelRaidPayloadSchema.parse(row.payload);
  const event = parsed.event;
  const occurredAt = row.receivedAt;

  await upsertTwitchUser(context, {
    userId: event.from_broadcaster_user_id,
    login: event.from_broadcaster_user_login,
    displayName: event.from_broadcaster_user_name
  });
  await upsertTwitchUser(context, {
    userId: event.to_broadcaster_user_id,
    login: event.to_broadcaster_user_login,
    displayName: event.to_broadcaster_user_name
  });
  await ensureTrackedChannel(context, event.to_broadcaster_user_id);

  const sourceStreamId = await findLiveStreamId(context, event.from_broadcaster_user_id);
  const targetStreamId = await findLiveStreamId(context, event.to_broadcaster_user_id);
  const duplicateWindowMs = 60_000;
  const [nearbyRaid] = await context.db
    .select({ rawEventsubEventId: raids.rawEventsubEventId })
    .from(raids)
    .where(and(
      eq(raids.sourceBroadcasterUserId, event.from_broadcaster_user_id),
      eq(raids.targetBroadcasterUserId, event.to_broadcaster_user_id),
      gte(raids.occurredAt, new Date(occurredAt.getTime() - duplicateWindowMs)),
      lte(raids.occurredAt, new Date(occurredAt.getTime() + duplicateWindowMs))
    ))
    .orderBy(raids.occurredAt)
    .limit(1);
  const duplicateDelivery = nearbyRaid != null && nearbyRaid.rawEventsubEventId !== row.id;
  if (!duplicateDelivery) {
    await context.db
      .insert(raids)
      .values({
        sourceBroadcasterUserId: event.from_broadcaster_user_id,
        targetBroadcasterUserId: event.to_broadcaster_user_id,
        viewerCount: event.viewers ?? null,
        occurredAt,
        sourceStreamId,
        targetStreamId,
        rawEventsubEventId: row.id
      })
      .onConflictDoNothing({
        target: raids.rawEventsubEventId
      });

    await insertChannelEvent(context, {
      eventType: "channel.raid",
      broadcasterUserId: event.to_broadcaster_user_id,
      twitchStreamId: targetStreamId,
      actorUserId: event.from_broadcaster_user_id,
      occurredAt,
      sourceEventId: sourceEventId(row),
      rawEventsubEventId: row.id
    });
  }
};

const reconcileSubscriptions = async (context: WorkerContext) => {
  if (!context.config.ENABLE_TWITCH_INGESTION || !context.config.EVENTSUB_ENABLED) {
    return {
      reconciledSubscriptions: 0,
      skipped: "EventSub reconciliation is disabled."
    };
  }

  if (context.config.TWITCH_CLIENT_ID === "" || context.config.TWITCH_CLIENT_SECRET === "") {
    return {
      reconciledSubscriptions: 0,
      skipped: "TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET is not configured."
    };
  }

  const callbackUrl = new URL("/api/webhooks/twitch/eventsub", context.config.PUBLIC_API_URL);
  if (callbackUrl.protocol !== "https:" || (callbackUrl.port !== "" && callbackUrl.port !== "443")) {
    return {
      reconciledSubscriptions: 0,
      skipped: "EventSub webhooks require a public HTTPS callback on port 443.",
      callbackUrl: callbackUrl.toString()
    };
  }

  const callback = callbackUrl.toString();
  const desiredChannelIds = await readDesiredChannelIds(context, callback);
  const desired = await upsertDesiredSubscriptions(context, callback, desiredChannelIds);

  const appToken = await getTwitchAppAccessToken({
    clientId: context.config.TWITCH_CLIENT_ID,
    clientSecret: context.config.TWITCH_CLIENT_SECRET
  });
  const eventsub = new FetchEventSubAdapter(context.config.TWITCH_CLIENT_ID);
  const locallyOwnedRemoteIds = new Set(
    (await context.db
      .select({ twitchSubscriptionId: eventsubSubscriptions.twitchSubscriptionId })
      .from(eventsubSubscriptions)
      .where(isNotNull(eventsubSubscriptions.twitchSubscriptionId)))
      .map((row) => row.twitchSubscriptionId)
      .filter((id): id is string => id != null)
  );
  const snapshot = await listActiveSubscriptions(eventsub, appToken.accessToken);
  const plan = planEventSubReconciliation({
    desired,
    remote: snapshot.subscriptions,
    callbackUrl: callback,
    locallyOwnedRemoteIds
  });

  for (const match of plan.matches) {
    await markSynced(context, match.desired.localId, match.remote);
  }

  const activeRemoteIds = new Set(snapshot.subscriptions.map((subscription) => subscription.id));
  const deletedOrphanedLocalRows = await deleteOrphanedLocalSubscriptions(context, activeRemoteIds);
  const deletedRemoteIds = new Set<string>();
  let deletedSubscriptions = 0;
  let failedDeletions = 0;
  let deletionRateLimited = false;
  const deletions = plan.stale.slice(0, context.config.EVENTSUB_MAX_DELETIONS_PER_RUN);
  const deletionConcurrency = 10;
  for (let index = 0; index < deletions.length && !deletionRateLimited; index += deletionConcurrency) {
    await Promise.all(deletions.slice(index, index + deletionConcurrency).map(async (subscription) => {
      try {
        await eventsub.deleteSubscription({
          accessToken: appToken.accessToken,
          subscriptionId: subscription.id
        });
        deletedRemoteIds.add(subscription.id);
        await clearDeletedLocalSubscription(context, subscription.id);
        deletedSubscriptions += 1;
      } catch (error) {
        failedDeletions += 1;
        if (error instanceof TwitchEventSubApiError && error.statusCode === 429) {
          deletionRateLimited = true;
        }
      }
    }));
  }

  const remainingRemote = snapshot.subscriptions.filter((subscription) => !deletedRemoteIds.has(subscription.id));
  const creatable = plan.missing.filter((subscription) => !hasEquivalentEventSubSubscription(subscription, remainingRemote));
  const blockedCreations = plan.missing.length - creatable.length;
  let createdSubscriptions = 0;
  let failedCreations = 0;
  let creationRateLimited = false;
  if (!deletionRateLimited) {
    for (const desiredSubscription of creatable.slice(0, context.config.EVENTSUB_MAX_CREATIONS_PER_RUN)) {
      await context.db
        .update(eventsubSubscriptions)
        .set({
          twitchSubscriptionId: null,
          status: "desired",
          cost: null,
          latestError: null,
          updatedAt: new Date()
        })
        .where(eq(eventsubSubscriptions.id, desiredSubscription.localId));
      try {
        const createdSubscription = await eventsub.createWebhookSubscription({
          accessToken: appToken.accessToken,
          type: desiredSubscription.type,
          version: desiredSubscription.version,
          condition: desiredSubscription.condition,
          callback: callback,
          secret: context.config.TWITCH_EVENTSUB_SECRET
        });
        await markSynced(context, desiredSubscription.localId, createdSubscription);
        createdSubscriptions += 1;
      } catch (error) {
        failedCreations += 1;
        await markSubscriptionFailure(context, desiredSubscription.localId, error);
        if (error instanceof TwitchEventSubApiError && error.statusCode === 429) {
          creationRateLimited = true;
          break;
        }
      }
    }
  }

  return {
    desiredChannels: desiredChannelIds.length,
    desiredSubscriptions: desired.length,
    activeTwitchSubscriptions: snapshot.subscriptions.length,
    twitchTotalCost: snapshot.totalCost,
    twitchMaxTotalCost: snapshot.maxTotalCost,
    matchedSubscriptions: plan.matches.length,
    staleSubscriptions: plan.stale.length,
    deletedSubscriptions,
    failedDeletions,
    deferredDeletions: plan.stale.length - deletedSubscriptions - failedDeletions,
    deletionRateLimited,
    deletedOrphanedLocalRows,
    missingSubscriptions: plan.missing.length,
    createdSubscriptions,
    failedCreations,
    blockedCreations,
    deferredCreations: Math.max(0, creatable.length - createdSubscriptions - failedCreations),
    creationRateLimited,
    unmanagedRemoteSubscriptions: plan.unmanagedRemoteSubscriptions
  };
};

const readDesiredChannelIds = async (context: WorkerContext, callbackUrl: string): Promise<string[]> => {
  const maxChannels = context.config.EVENTSUB_MAX_CHANNELS;
  if (maxChannels === 0) {
    return [];
  }

  const recentCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
  const candidates = await context.db
    .select({
      twitchUserId: channels.twitchUserId,
      isManuallyPinned: channels.isManuallyPinned,
      lastSeenFinnishAt: channels.lastSeenFinnishAt
    })
    .from(channels)
    .leftJoin(subjectPrivacyStates, eq(channels.twitchUserId, subjectPrivacyStates.twitchUserId))
    .where(and(
      or(eq(channels.isManuallyPinned, true), eq(channels.hasBeenSeenFinnish, true)),
      or(isNull(subjectPrivacyStates.twitchUserId), eq(subjectPrivacyStates.trackingOptedOut, false))
    ))
    .orderBy(desc(channels.isManuallyPinned), desc(channels.trackingPriority), desc(channels.lastSeenFinnishAt), asc(channels.twitchUserId));
  const previousDesiredRows = await context.db
    .select({ broadcasterUserId: eventsubSubscriptions.broadcasterUserId })
    .from(eventsubSubscriptions)
    .where(and(eq(eventsubSubscriptions.isDesired, true), eq(eventsubSubscriptions.callbackUrl, callbackUrl)))
    .orderBy(sql`${eventsubSubscriptions.lastSyncedAt} desc nulls last`, desc(eventsubSubscriptions.updatedAt));
  let previousChannelIds = previousDesiredRows.map((row) => row.broadcasterUserId);
  if (previousDesiredRows.length === 0) {
    const recentlySyncedRows = await context.db
      .select({ broadcasterUserId: eventsubSubscriptions.broadcasterUserId })
      .from(eventsubSubscriptions)
      .where(and(
        eq(eventsubSubscriptions.callbackUrl, callbackUrl),
        isNotNull(eventsubSubscriptions.broadcasterUserId),
        isNotNull(eventsubSubscriptions.twitchSubscriptionId)
      ))
      .orderBy(sql`${eventsubSubscriptions.lastSyncedAt} desc nulls last`, desc(eventsubSubscriptions.updatedAt))
      .limit(maxChannels * desiredDefinitions("placeholder").length * 2);
    previousChannelIds = recentlySyncedRows.map((row) => row.broadcasterUserId);
  }

  return selectDesiredEventSubChannelIds({
    candidates,
    previousChannelIds,
    maxChannels,
    recentCutoff
  });
};

const upsertDesiredSubscriptions = async (
  context: WorkerContext,
  callbackUrl: string,
  desiredChannelIds: string[]
): Promise<DesiredSubscription[]> => {
  await context.db
    .update(eventsubSubscriptions)
    .set({ isDesired: false, updatedAt: new Date() })
    .where(eq(eventsubSubscriptions.isDesired, true));

  const desired: DesiredSubscription[] = [];
  for (const twitchUserId of desiredChannelIds) {
    for (const definition of desiredDefinitions(twitchUserId)) {
      const conditionKey = stableConditionKey(definition.condition);
      const [row] = await context.db
        .insert(eventsubSubscriptions)
        .values({
          eventType: definition.type,
          eventVersion: definition.version,
          condition: definition.condition,
          conditionKey,
          broadcasterUserId: twitchUserId,
          transportMethod: "webhook",
          callbackUrl,
          status: "desired",
          isDesired: true
        })
        .onConflictDoUpdate({
          target: [
            eventsubSubscriptions.eventType,
            eventsubSubscriptions.eventVersion,
            eventsubSubscriptions.conditionKey,
            eventsubSubscriptions.callbackUrl
          ],
          set: {
            condition: definition.condition,
            broadcasterUserId: twitchUserId,
            transportMethod: "webhook",
            status: sql`case when ${eventsubSubscriptions.status} in ('enabled', 'webhook_callback_verification_pending') then ${eventsubSubscriptions.status} else 'desired' end`,
            isDesired: true,
            latestError: null,
            updatedAt: new Date()
          }
        })
        .returning({
          id: eventsubSubscriptions.id,
          twitchSubscriptionId: eventsubSubscriptions.twitchSubscriptionId
        });

      if (row == null) {
        throw new Error("Failed to upsert desired EventSub subscription.");
      }

      desired.push({
        localId: row.id,
        twitchSubscriptionId: row.twitchSubscriptionId,
        type: definition.type,
        version: definition.version,
        condition: definition.condition,
        broadcasterUserId: twitchUserId,
        callbackUrl
      });
    }
  }

  return desired;
};

const desiredDefinitions = (broadcasterUserId: string) => [
  {
    type: "stream.online",
    version: "1",
    condition: { broadcaster_user_id: broadcasterUserId }
  },
  {
    type: "stream.offline",
    version: "1",
    condition: { broadcaster_user_id: broadcasterUserId }
  },
  {
    type: "channel.update",
    version: "2",
    condition: { broadcaster_user_id: broadcasterUserId }
  },
  {
    type: "channel.raid",
    version: "1",
    condition: { to_broadcaster_user_id: broadcasterUserId }
  },
  {
    type: "channel.raid",
    version: "1",
    condition: { from_broadcaster_user_id: broadcasterUserId }
  },
  {
    type: "channel.shared_chat.begin",
    version: "1",
    condition: { broadcaster_user_id: broadcasterUserId }
  },
  {
    type: "channel.shared_chat.update",
    version: "1",
    condition: { broadcaster_user_id: broadcasterUserId }
  },
  {
    type: "channel.shared_chat.end",
    version: "1",
    condition: { broadcaster_user_id: broadcasterUserId }
  },
  {
    type: "user.update",
    version: "1",
    condition: { user_id: broadcasterUserId }
  }
];

const listActiveSubscriptions = async (eventsub: FetchEventSubAdapter, accessToken: string) => {
  const subscriptionsById = new Map<string, EventSubSubscription>();
  let totalCost = 0;
  let maxTotalCost = 0;
  for (const status of ["webhook_callback_verification_pending", "enabled"]) {
    let cursor: string | null = null;
    let firstPage = true;
    do {
      const page = await eventsub.listSubscriptions({
        accessToken,
        status,
        ...(cursor == null ? {} : { after: cursor })
      });
      for (const subscription of page.data) {
        subscriptionsById.set(subscription.id, subscription);
      }
      if (firstPage) {
        totalCost = Math.max(totalCost, page.totalCost);
        maxTotalCost = Math.max(maxTotalCost, page.maxTotalCost);
        firstPage = false;
      }
      cursor = page.cursor;
    } while (cursor != null);
  }

  return {
    subscriptions: [...subscriptionsById.values()],
    totalCost,
    maxTotalCost
  };
};

const deleteOrphanedLocalSubscriptions = async (context: WorkerContext, activeRemoteIds: Set<string>) => {
  const rows = await context.db
    .select({
      id: eventsubSubscriptions.id,
      twitchSubscriptionId: eventsubSubscriptions.twitchSubscriptionId
    })
    .from(eventsubSubscriptions)
    .where(eq(eventsubSubscriptions.isDesired, false));
  const orphanedIds = rows
    .filter((row) => row.twitchSubscriptionId == null || !activeRemoteIds.has(row.twitchSubscriptionId))
    .map((row) => row.id);
  for (let index = 0; index < orphanedIds.length; index += 500) {
    await context.db
      .delete(eventsubSubscriptions)
      .where(inArray(eventsubSubscriptions.id, orphanedIds.slice(index, index + 500)));
  }
  return orphanedIds.length;
};

const clearDeletedLocalSubscription = async (context: WorkerContext, twitchSubscriptionId: string) => {
  await context.db
    .update(eventsubSubscriptions)
    .set({
      twitchSubscriptionId: null,
      status: "desired",
      cost: null,
      latestError: null,
      lastSyncedAt: new Date(),
      updatedAt: new Date()
    })
    .where(and(
      eq(eventsubSubscriptions.twitchSubscriptionId, twitchSubscriptionId),
      eq(eventsubSubscriptions.isDesired, true)
    ));
  await context.db
    .delete(eventsubSubscriptions)
    .where(and(
      eq(eventsubSubscriptions.twitchSubscriptionId, twitchSubscriptionId),
      eq(eventsubSubscriptions.isDesired, false)
    ));
};

const markSubscriptionFailure = async (context: WorkerContext, localId: string, error: unknown) => {
  await context.db
    .update(eventsubSubscriptions)
    .set({
      status: "failed",
      latestError: error instanceof Error ? error.message : String(error),
      lastSyncedAt: new Date(),
      updatedAt: new Date()
    })
    .where(eq(eventsubSubscriptions.id, localId));
};

const markSynced = async (context: WorkerContext, localId: string, subscription: EventSubSubscription) => {
  await context.db
    .update(eventsubSubscriptions)
    .set({
      twitchSubscriptionId: subscription.id,
      status: subscription.status,
      cost: subscription.cost,
      lastSyncedAt: new Date(),
      latestError: null,
      updatedAt: new Date()
    })
    .where(eq(eventsubSubscriptions.id, localId));
};

const upsertTwitchUser = async (
  context: WorkerContext,
  input: { userId: string; login: string | null | undefined; displayName: string | null | undefined }
) => {
  const now = new Date();
  const updateSet: Partial<typeof twitchUsers.$inferInsert> = {
    lastSeenAt: now,
    updatedAt: now
  };
  if (input.login != null) {
    updateSet.login = input.login;
  }
  if (input.displayName != null) {
    updateSet.displayName = input.displayName;
  }

  await context.db
    .insert(twitchUsers)
    .values({
      twitchUserId: input.userId,
      login: input.login ?? null,
      displayName: input.displayName ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: twitchUsers.twitchUserId,
      set: updateSet
    });
};

const ensureTrackedChannel = async (context: WorkerContext, twitchUserId: string) => {
  const now = new Date();
  await context.db
    .insert(channels)
    .values({
      twitchUserId,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: channels.twitchUserId,
      set: {
        updatedAt: now
      }
    });
};

const insertChannelEvent = async (
  context: WorkerContext,
  input: {
    eventType: string;
    broadcasterUserId: string;
    twitchStreamId: string | null;
    actorUserId: string | null;
    occurredAt: Date;
    sourceEventId: string;
    rawEventsubEventId: string;
  }
) => {
  await context.db
    .insert(channelEvents)
    .values({
      eventType: input.eventType,
      broadcasterUserId: input.broadcasterUserId,
      twitchStreamId: input.twitchStreamId,
      actorUserId: input.actorUserId,
      occurredAt: input.occurredAt,
      source: "eventsub",
      sourceEventId: input.sourceEventId,
      rawEventsubEventId: input.rawEventsubEventId
    })
    .onConflictDoNothing({
      target: [channelEvents.source, channelEvents.eventType, channelEvents.sourceEventId]
    });
};

const findLiveStreamId = async (context: WorkerContext, broadcasterUserId: string): Promise<string | null> => {
  const [row] = await context.db
    .select({ twitchStreamId: streamSessions.twitchStreamId })
    .from(streamSessions)
    .where(and(eq(streamSessions.broadcasterUserId, broadcasterUserId), isNull(streamSessions.endedAt)))
    .orderBy(desc(streamSessions.lastSeenLiveAt))
    .limit(1);

  return row?.twitchStreamId ?? null;
};

const findStreamForOfflineEvent = async (context: WorkerContext, eventStreamId: string, broadcasterUserId: string): Promise<string | null> => {
  const [byId] = await context.db
    .select({ twitchStreamId: streamSessions.twitchStreamId })
    .from(streamSessions)
    .where(eq(streamSessions.twitchStreamId, eventStreamId))
    .limit(1);
  if (byId != null) {
    return byId.twitchStreamId;
  }

  return findLiveStreamId(context, broadcasterUserId);
};

const markEventSubProcessed = async (context: WorkerContext, row: RawEventSubRow) => {
  await context.db
    .update(rawEventsubEvents)
    .set({
      processingStatus: "processed",
      errorMessage: null,
      updatedAt: new Date()
    })
    .where(eq(rawEventsubEvents.id, row.id));
};

const markEventSubFailed = async (context: WorkerContext, row: RawEventSubRow, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  await context.db.insert(eventProcessingFailures).values({
    rawSource: "eventsub",
    rawId: row.id,
    handlerName: row.eventType,
    errorClass: error instanceof Error ? error.name : "UnknownError",
    errorMessage: message
  });
  await context.db
    .update(rawEventsubEvents)
    .set({
      processingStatus: "failed",
      errorMessage: message,
      updatedAt: new Date()
    })
    .where(eq(rawEventsubEvents.id, row.id));
};

const parseEventDate = (value: string): Date => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid EventSub timestamp: ${value}`);
  }
  return date;
};

const sourceEventId = (row: RawEventSubRow) => {
  return row.twitchEventId ?? row.twitchMessageId ?? row.id;
};

const stableConditionKey = (condition: Record<string, string>) => {
  return JSON.stringify(Object.fromEntries(
    Object.entries(condition)
      .filter(([, value]) => value !== "")
      .sort(([left], [right]) => left.localeCompare(right))
  ));
};

const readEventString = (event: Record<string, unknown>, key: string): string | null => {
  const value = event[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};
