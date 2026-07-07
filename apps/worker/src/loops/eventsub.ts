import {
  channelEvents,
  channels,
  eventProcessingFailures,
  eventsubSubscriptions,
  raids,
  rawEventsubEvents,
  streamSessions,
  twitchUsers
} from "@twitch-tracker/db";
import { FetchEventSubAdapter, getTwitchAppAccessToken, type EventSubSubscription } from "@twitch-tracker/twitch";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { WorkerContext } from "../worker.js";
import { startIntervalLoop } from "./common.js";

type DesiredSubscription = {
  localId: string;
  type: string;
  version: string;
  condition: Record<string, string>;
  conditionKey: string;
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
  event: z.record(z.unknown())
});

export const runEventSubLoop = (context: WorkerContext) => {
  startIntervalLoop({
    name: "eventsub",
    intervalMs: context.config.MAINTENANCE_INTERVAL_MS,
    context,
    run: async () => {
      const processing = await processPendingEventSubEvents(context);
      const reconciliation = await reconcileSubscriptions(context);

      return {
        ...processing,
        ...reconciliation
      };
    }
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
  await upsertTrackedChannel(context, userId);

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
  await upsertTrackedChannel(context, broadcasterUserId);

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
  await upsertTrackedChannel(context, event.broadcaster_user_id);

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
  await upsertTrackedChannel(context, event.broadcaster_user_id);

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
  await upsertTrackedChannel(context, event.broadcaster_user_id);

  const liveStreamId = await findLiveStreamId(context, event.broadcaster_user_id);
  if (liveStreamId != null) {
    await context.db
      .update(streamSessions)
      .set({
        latestTitle: event.title ?? null,
        language: event.language ?? null,
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
  await upsertTrackedChannel(context, event.to_broadcaster_user_id);

  const sourceStreamId = await findLiveStreamId(context, event.from_broadcaster_user_id);
  const targetStreamId = await findLiveStreamId(context, event.to_broadcaster_user_id);
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

  const desired = await upsertDesiredSubscriptions(context, callbackUrl.toString());
  if (desired.length === 0) {
    return {
      reconciledSubscriptions: 0,
      desiredSubscriptions: 0
    };
  }

  const appToken = await getTwitchAppAccessToken({
    clientId: context.config.TWITCH_CLIENT_ID,
    clientSecret: context.config.TWITCH_CLIENT_SECRET
  });
  const eventsub = new FetchEventSubAdapter(context.config.TWITCH_CLIENT_ID);
  const twitchSubscriptions = await listAllSubscriptions(eventsub, appToken.accessToken);
  const existingByKey = new Map(
    twitchSubscriptions
      .filter((subscription) => subscription.transport.method === "webhook" && subscription.transport.callback === callbackUrl.toString())
      .map((subscription) => [subscriptionKey(subscription.type, subscription.version, subscription.condition), subscription])
  );

  let matched = 0;
  let created = 0;
  let failed = 0;
  for (const desiredSubscription of desired) {
    const existing = existingByKey.get(subscriptionKey(desiredSubscription.type, desiredSubscription.version, desiredSubscription.condition));
    if (existing != null) {
      await markSynced(context, desiredSubscription.localId, existing);
      matched += 1;
      continue;
    }

    try {
      const createdSubscription = await eventsub.createWebhookSubscription({
        accessToken: appToken.accessToken,
        type: desiredSubscription.type,
        version: desiredSubscription.version,
        condition: desiredSubscription.condition,
        callback: desiredSubscription.callbackUrl,
        secret: context.config.TWITCH_EVENTSUB_SECRET
      });
      await markSynced(context, desiredSubscription.localId, createdSubscription);
      created += 1;
    } catch (error) {
      failed += 1;
      await context.db
        .update(eventsubSubscriptions)
        .set({
          status: "failed",
          latestError: error instanceof Error ? error.message : String(error),
          lastSyncedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(eventsubSubscriptions.id, desiredSubscription.localId));
    }
  }

  return {
    desiredSubscriptions: desired.length,
    twitchSubscriptions: twitchSubscriptions.length,
    matchedSubscriptions: matched,
    createdSubscriptions: created,
    failedSubscriptions: failed
  };
};

const upsertDesiredSubscriptions = async (context: WorkerContext, callbackUrl: string): Promise<DesiredSubscription[]> => {
  const trackedChannels = await context.db
    .select({
      twitchUserId: channels.twitchUserId
    })
    .from(channels)
    .where(eq(channels.hasBeenSeenFinnish, true))
    .orderBy(desc(channels.lastSeenFinnishAt))
    .limit(context.config.EVENTSUB_MAX_CHANNELS);

  const desired: DesiredSubscription[] = [];
  for (const channel of trackedChannels) {
    for (const definition of desiredDefinitions(channel.twitchUserId)) {
      const conditionKey = stableConditionKey(definition.condition);
      const [row] = await context.db
        .insert(eventsubSubscriptions)
        .values({
          eventType: definition.type,
          eventVersion: definition.version,
          condition: definition.condition,
          conditionKey,
          broadcasterUserId: channel.twitchUserId,
          transportMethod: "webhook",
          callbackUrl,
          status: "desired"
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
            broadcasterUserId: channel.twitchUserId,
            transportMethod: "webhook",
            status: sql`case when ${eventsubSubscriptions.status} in ('enabled', 'webhook_callback_verification_pending') then ${eventsubSubscriptions.status} else 'desired' end`,
            latestError: null,
            updatedAt: new Date()
          }
        })
        .returning({ id: eventsubSubscriptions.id });

      if (row == null) {
        throw new Error("Failed to upsert desired EventSub subscription.");
      }

      desired.push({
        localId: row.id,
        type: definition.type,
        version: definition.version,
        condition: definition.condition,
        conditionKey,
        broadcasterUserId: channel.twitchUserId,
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

const listAllSubscriptions = async (eventsub: FetchEventSubAdapter, accessToken: string): Promise<EventSubSubscription[]> => {
  const subscriptions: EventSubSubscription[] = [];
  let cursor: string | null = null;
  do {
    const page = await eventsub.listSubscriptions(cursor == null ? { accessToken } : { accessToken, after: cursor });
    subscriptions.push(...page.data);
    cursor = page.cursor;
  } while (cursor != null);

  return subscriptions;
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

const upsertTrackedChannel = async (context: WorkerContext, twitchUserId: string) => {
  const now = new Date();
  await context.db
    .insert(channels)
    .values({
      twitchUserId,
      hasBeenSeenFinnish: true,
      firstSeenFinnishAt: now,
      lastSeenFinnishAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: channels.twitchUserId,
      set: {
        hasBeenSeenFinnish: true,
        lastSeenFinnishAt: now,
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

const subscriptionKey = (type: string, version: string, condition: Record<string, string>) => {
  return `${type}:${version}:${stableConditionKey(condition)}`;
};

const stableConditionKey = (condition: Record<string, string>) => {
  return JSON.stringify(Object.fromEntries(Object.entries(condition).sort(([left], [right]) => left.localeCompare(right))));
};

const readEventString = (event: Record<string, unknown>, key: string): string | null => {
  const value = event[key];
  return typeof value === "string" && value.length > 0 ? value : null;
};
