import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, boolean } from "drizzle-orm/pg-core";

export const appModeEnum = pgEnum("app_mode", ["local", "private_mvp", "production"]);
export const assignmentStatusEnum = pgEnum("assignment_status", ["desired", "joining", "joined", "leaving", "left", "failed"]);
export const chatMembershipEventTypeEnum = pgEnum("chat_membership_event_type", ["join", "part"]);
export const ingestionRunStatusEnum = pgEnum("ingestion_run_status", ["running", "succeeded", "failed", "skipped"]);
export const privacyRequestStatusEnum = pgEnum("privacy_request_status", ["pending", "completed", "rejected"]);
export const privacyRequestTypeEnum = pgEnum("privacy_request_type", ["public_profile_opt_out", "tracking_opt_out", "data_deletion"]);
export const rawProcessingStatusEnum = pgEnum("raw_processing_status", ["pending", "processed", "failed", "ignored"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
};

export const twitchUsers = pgTable("twitch_users", {
  twitchUserId: text("twitch_user_id").primaryKey(),
  login: text("login"),
  displayName: text("display_name"),
  accountType: text("account_type"),
  broadcasterType: text("broadcaster_type"),
  description: text("description"),
  profileImageUrl: text("profile_image_url"),
  offlineImageUrl: text("offline_image_url"),
  twitchCreatedAt: timestamp("twitch_created_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastMetadataRefreshAt: timestamp("last_metadata_refresh_at", { withTimezone: true }),
  ...timestamps
}, (table) => ({
  loginIdx: index("twitch_users_login_idx").on(table.login)
}));

export const twitchUserNameHistory = pgTable("twitch_user_name_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  twitchUserId: text("twitch_user_id").notNull().references(() => twitchUsers.twitchUserId),
  login: text("login").notNull(),
  displayName: text("display_name").notNull(),
  observedFrom: timestamp("observed_from", { withTimezone: true }).defaultNow().notNull(),
  observedUntil: timestamp("observed_until", { withTimezone: true }),
  source: text("source").notNull(),
  ...timestamps
}, (table) => ({
  userObservedIdx: index("twitch_user_name_history_user_observed_idx").on(table.twitchUserId, table.observedFrom)
}));

export const channels = pgTable("channels", {
  twitchUserId: text("twitch_user_id").primaryKey().references(() => twitchUsers.twitchUserId),
  hasBeenSeenFinnish: boolean("has_been_seen_finnish").default(false).notNull(),
  firstSeenFinnishAt: timestamp("first_seen_finnish_at", { withTimezone: true }),
  lastSeenFinnishAt: timestamp("last_seen_finnish_at", { withTimezone: true }),
  isManuallyPinned: boolean("is_manually_pinned").default(false).notNull(),
  isOptedIn: boolean("is_opted_in").default(false).notNull(),
  isKnownModerator: boolean("is_known_moderator").default(false).notNull(),
  trackingPriority: integer("tracking_priority").default(0).notNull(),
  notes: text("notes"),
  tags: jsonb("tags").$type<string[]>().default([]).notNull(),
  ...timestamps
});

export const streamSessions = pgTable("stream_sessions", {
  twitchStreamId: text("twitch_stream_id").primaryKey(),
  broadcasterUserId: text("broadcaster_user_id").notNull().references(() => twitchUsers.twitchUserId),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenLiveAt: timestamp("last_seen_live_at", { withTimezone: true }).defaultNow().notNull(),
  endDetectionSource: text("end_detection_source"),
  language: text("language"),
  initialTitle: text("initial_title"),
  latestTitle: text("latest_title"),
  initialCategoryId: text("initial_category_id"),
  initialCategoryName: text("initial_category_name"),
  latestCategoryId: text("latest_category_id"),
  latestCategoryName: text("latest_category_name"),
  mature: boolean("mature"),
  ...timestamps
}, (table) => ({
  broadcasterLiveIdx: index("stream_sessions_broadcaster_live_idx").on(table.broadcasterUserId, table.endedAt),
  broadcasterStartedIdx: index("stream_sessions_broadcaster_started_idx").on(table.broadcasterUserId, table.startedAt),
  liveLanguageIdx: index("stream_sessions_live_language_idx").on(table.language, table.lastSeenLiveAt).where(sql`${table.endedAt} is null`),
  recentEndedIdx: index("stream_sessions_recent_ended_idx").on(table.language, table.endedAt).where(sql`${table.endedAt} is not null`),
  startedAtIdx: index("stream_sessions_started_at_idx").on(table.startedAt)
}));

export const streamSnapshots = pgTable("stream_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  twitchStreamId: text("twitch_stream_id").notNull().references(() => streamSessions.twitchStreamId),
  broadcasterUserId: text("broadcaster_user_id").notNull().references(() => twitchUsers.twitchUserId),
  observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
  viewerCount: integer("viewer_count"),
  title: text("title"),
  categoryId: text("category_id"),
  categoryName: text("category_name"),
  language: text("language"),
  tags: jsonb("tags").$type<string[]>().default([]).notNull(),
  thumbnailUrl: text("thumbnail_url"),
  sourceRunId: uuid("source_run_id"),
  ...timestamps
}, (table) => ({
  streamObservedIdx: index("stream_snapshots_stream_observed_idx").on(table.twitchStreamId, table.observedAt),
  broadcasterObservedIdx: index("stream_snapshots_broadcaster_observed_idx").on(table.broadcasterUserId, table.observedAt)
}));

export const botAccounts = pgTable("bot_accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  twitchUserId: text("twitch_user_id").references(() => twitchUsers.twitchUserId),
  login: text("login").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  maxJoinedRooms: integer("max_joined_rooms").default(100).notNull(),
  joinRatePer10Seconds: integer("join_rate_per_10_seconds").default(20).notNull(),
  priority: integer("priority").default(0).notNull(),
  healthStatus: text("health_status").default("unknown").notNull(),
  ...timestamps
}, (table) => ({
  loginIdx: uniqueIndex("bot_accounts_login_idx").on(table.login)
}));

export const botAccountTokens = pgTable("bot_account_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  botAccountId: uuid("bot_account_id").notNull().references(() => botAccounts.id),
  scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
  encryptedAccessToken: text("encrypted_access_token"),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  refreshStatus: text("refresh_status").default("unknown").notNull(),
  ...timestamps
});

export const chatAssignments = pgTable("chat_assignments", {
  id: uuid("id").defaultRandom().primaryKey(),
  botAccountId: uuid("bot_account_id").notNull().references(() => botAccounts.id),
  broadcasterUserId: text("broadcaster_user_id").notNull().references(() => twitchUsers.twitchUserId),
  twitchStreamId: text("twitch_stream_id").references(() => streamSessions.twitchStreamId),
  status: assignmentStatusEnum("status").default("desired").notNull(),
  priorityScore: integer("priority_score").default(0).notNull(),
  joinMethod: text("join_method").default("irc").notNull(),
  reason: text("reason").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }),
  leftAt: timestamp("left_at", { withTimezone: true }),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  lastMembershipEventAt: timestamp("last_membership_event_at", { withTimezone: true }),
  latestError: text("latest_error"),
  ...timestamps
}, (table) => ({
  activeAssignmentIdx: index("chat_assignments_active_idx").on(table.status, table.priorityScore),
  channelAssignmentIdx: index("chat_assignments_channel_idx").on(table.broadcasterUserId, table.status),
  streamStatusIdx: index("chat_assignments_stream_status_idx").on(table.twitchStreamId, table.status),
  assignmentIdentityIdx: uniqueIndex("chat_assignments_identity_idx").on(table.botAccountId, table.broadcasterUserId, table.twitchStreamId)
}));

export const chatAssignmentEvents = pgTable("chat_assignment_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  chatAssignmentId: uuid("chat_assignment_id").notNull().references(() => chatAssignments.id),
  eventType: text("event_type").notNull(),
  reason: text("reason").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  ...timestamps
});

export const ircConnections = pgTable("irc_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  botAccountId: uuid("bot_account_id").notNull().references(() => botAccounts.id),
  status: text("status").default("created").notNull(),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  lastPingAt: timestamp("last_ping_at", { withTimezone: true }),
  lastPongAt: timestamp("last_pong_at", { withTimezone: true }),
  reconnectCount: integer("reconnect_count").default(0).notNull(),
  latestError: text("latest_error"),
  ...timestamps
});

export const ingestionRuns = pgTable("ingestion_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  jobType: text("job_type").notNull(),
  status: ingestionRunStatusEnum("status").default("running").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  itemsRequested: integer("items_requested").default(0).notNull(),
  itemsInserted: integer("items_inserted").default(0).notNull(),
  itemsUpdated: integer("items_updated").default(0).notNull(),
  itemsSkipped: integer("items_skipped").default(0).notNull(),
  errorClass: text("error_class"),
  errorMessage: text("error_message"),
  summary: jsonb("summary").$type<Record<string, unknown>>().default({}).notNull(),
  ...timestamps
});

export const rawHelixResponses = pgTable("raw_helix_responses", {
  id: uuid("id").defaultRandom().primaryKey(),
  endpoint: text("endpoint").notNull(),
  requestParams: jsonb("request_params").$type<Record<string, unknown>>().default({}).notNull(),
  statusCode: integer("status_code").notNull(),
  responseJson: jsonb("response_json").$type<unknown>(),
  pagination: jsonb("pagination").$type<Record<string, unknown>>().default({}).notNull(),
  rateLimitHeaders: jsonb("rate_limit_headers").$type<Record<string, string>>().default({}).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
  ingestionRunId: uuid("ingestion_run_id").references(() => ingestionRuns.id),
  processingStatus: rawProcessingStatusEnum("processing_status").default("pending").notNull(),
  ...timestamps
});

export const rawIrcMessages = pgTable("raw_irc_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  rawLine: text("raw_line").notNull(),
  parsedCommand: text("parsed_command"),
  tags: jsonb("tags").$type<Record<string, string>>().default({}).notNull(),
  channelLogin: text("channel_login"),
  botAccountId: uuid("bot_account_id").references(() => botAccounts.id),
  ircConnectionId: uuid("irc_connection_id").references(() => ircConnections.id),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  processingStatus: rawProcessingStatusEnum("processing_status").default("pending").notNull(),
  parseError: text("parse_error"),
  ...timestamps
}, (table) => ({
  receivedIdx: index("raw_irc_messages_received_idx").on(table.receivedAt),
  channelReceivedIdx: index("raw_irc_messages_channel_received_idx").on(table.channelLogin, table.receivedAt)
}));

export const rawEventsubEvents = pgTable("raw_eventsub_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  twitchMessageId: text("twitch_message_id"),
  twitchEventId: text("twitch_event_id"),
  subscriptionId: text("subscription_id"),
  eventType: text("event_type").notNull(),
  eventVersion: text("event_version"),
  payload: jsonb("payload").$type<unknown>().notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  processingStatus: rawProcessingStatusEnum("processing_status").default("pending").notNull(),
  errorMessage: text("error_message"),
  ...timestamps
}, (table) => ({
  messageIdx: uniqueIndex("raw_eventsub_events_message_idx").on(table.twitchMessageId),
  typeReceivedIdx: index("raw_eventsub_events_type_received_idx").on(table.eventType, table.receivedAt)
}));

export const eventsubSubscriptions = pgTable("eventsub_subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  twitchSubscriptionId: text("twitch_subscription_id"),
  eventType: text("event_type").notNull(),
  eventVersion: text("event_version").notNull(),
  condition: jsonb("condition").$type<Record<string, string>>().default({}).notNull(),
  conditionKey: text("condition_key").notNull(),
  broadcasterUserId: text("broadcaster_user_id").references(() => twitchUsers.twitchUserId),
  transportMethod: text("transport_method").default("webhook").notNull(),
  callbackUrl: text("callback_url").notNull(),
  status: text("status").default("desired").notNull(),
  cost: integer("cost"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  latestError: text("latest_error"),
  ...timestamps
}, (table) => ({
  twitchSubscriptionIdx: uniqueIndex("eventsub_subscriptions_twitch_subscription_idx").on(table.twitchSubscriptionId),
  desiredIdentityIdx: uniqueIndex("eventsub_subscriptions_desired_identity_idx").on(table.eventType, table.eventVersion, table.conditionKey, table.callbackUrl),
  statusIdx: index("eventsub_subscriptions_status_idx").on(table.status, table.updatedAt)
}));

export const chatMessages = pgTable("chat_messages", {
  twitchMessageId: text("twitch_message_id").primaryKey(),
  broadcasterUserId: text("broadcaster_user_id").notNull().references(() => twitchUsers.twitchUserId),
  twitchStreamId: text("twitch_stream_id").references(() => streamSessions.twitchStreamId),
  chatterUserId: text("chatter_user_id").references(() => twitchUsers.twitchUserId),
  chatterLogin: text("chatter_login"),
  source: text("source").default("irc").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  messageType: text("message_type").default("privmsg").notNull(),
  rawText: text("raw_text"),
  badges: jsonb("badges").$type<Record<string, string>>().default({}).notNull(),
  emotes: jsonb("emotes").$type<Record<string, unknown>>().default({}).notNull(),
  replyParentMessageId: text("reply_parent_message_id"),
  sharedChatSourceChannelId: text("shared_chat_source_channel_id"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  clearedAt: timestamp("cleared_at", { withTimezone: true }),
  rawIrcMessageId: uuid("raw_irc_message_id").references(() => rawIrcMessages.id),
  rawEventsubEventId: uuid("raw_eventsub_event_id").references(() => rawEventsubEvents.id),
  ...timestamps
}, (table) => ({
  receivedIdx: index("chat_messages_received_idx").on(table.receivedAt),
  streamReceivedIdx: index("chat_messages_stream_received_idx").on(table.twitchStreamId, table.receivedAt),
  channelReceivedIdx: index("chat_messages_channel_received_idx").on(table.broadcasterUserId, table.receivedAt),
  chatterReceivedIdx: index("chat_messages_chatter_received_idx").on(table.chatterUserId, table.receivedAt)
}));

export const chatMembershipEvents = pgTable("chat_membership_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  broadcasterUserId: text("broadcaster_user_id").notNull().references(() => twitchUsers.twitchUserId),
  chatterUserId: text("chatter_user_id").references(() => twitchUsers.twitchUserId),
  chatterLogin: text("chatter_login"),
  twitchStreamId: text("twitch_stream_id").references(() => streamSessions.twitchStreamId),
  eventType: chatMembershipEventTypeEnum("event_type").notNull(),
  source: text("source").default("irc_membership").notNull(),
  confidence: integer("confidence").default(70).notNull(),
  dedupeKey: text("dedupe_key"),
  eventAt: timestamp("event_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  ircConnectionId: uuid("irc_connection_id").references(() => ircConnections.id),
  rawIrcMessageId: uuid("raw_irc_message_id").references(() => rawIrcMessages.id),
  ...timestamps
}, (table) => ({
  channelReceivedIdx: index("chat_membership_events_channel_received_idx").on(table.broadcasterUserId, table.receivedAt),
  chatterReceivedIdx: index("chat_membership_events_chatter_received_idx").on(table.chatterUserId, table.receivedAt),
  dedupeKeyIdx: uniqueIndex("chat_membership_events_dedupe_key_idx").on(table.dedupeKey)
}));

export const chatPresenceSnapshots = pgTable("chat_presence_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  broadcasterUserId: text("broadcaster_user_id").notNull().references(() => twitchUsers.twitchUserId),
  twitchStreamId: text("twitch_stream_id").references(() => streamSessions.twitchStreamId),
  botAccountId: uuid("bot_account_id").references(() => botAccounts.id),
  source: text("source").notNull(),
  confidence: integer("confidence").default(90).notNull(),
  sampledAt: timestamp("sampled_at", { withTimezone: true }).defaultNow().notNull(),
  chatterCount: integer("chatter_count").default(0).notNull(),
  pageCount: integer("page_count").default(0).notNull(),
  requestStatus: text("request_status").default("succeeded").notNull(),
  latestError: text("latest_error"),
  ...timestamps
}, (table) => ({
  channelSampledIdx: index("chat_presence_snapshots_channel_sampled_idx").on(table.broadcasterUserId, table.sampledAt),
  streamSampledIdx: index("chat_presence_snapshots_stream_sampled_idx").on(table.twitchStreamId, table.sampledAt)
}));

export const chatPresenceObservations = pgTable("chat_presence_observations", {
  id: uuid("id").defaultRandom().primaryKey(),
  snapshotId: uuid("snapshot_id").notNull().references(() => chatPresenceSnapshots.id),
  broadcasterUserId: text("broadcaster_user_id").notNull().references(() => twitchUsers.twitchUserId),
  chatterUserId: text("chatter_user_id").references(() => twitchUsers.twitchUserId),
  chatterLogin: text("chatter_login"),
  chatterDisplayName: text("chatter_display_name"),
  twitchStreamId: text("twitch_stream_id").references(() => streamSessions.twitchStreamId),
  observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
  source: text("source").notNull(),
  confidence: integer("confidence").default(90).notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  ...timestamps
}, (table) => ({
  dedupeKeyIdx: uniqueIndex("chat_presence_observations_dedupe_key_idx").on(table.dedupeKey),
  channelObservedIdx: index("chat_presence_observations_channel_observed_idx").on(table.broadcasterUserId, table.observedAt),
  chatterObservedIdx: index("chat_presence_observations_chatter_observed_idx").on(table.chatterUserId, table.observedAt)
}));

export const chatRoomStateEvents = pgTable("chat_room_state_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  broadcasterUserId: text("broadcaster_user_id").references(() => twitchUsers.twitchUserId),
  botAccountId: uuid("bot_account_id").references(() => botAccounts.id),
  stateType: text("state_type").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
  rawIrcMessageId: uuid("raw_irc_message_id").references(() => rawIrcMessages.id),
  ...timestamps
});

export const channelEvents = pgTable("channel_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventType: text("event_type").notNull(),
  broadcasterUserId: text("broadcaster_user_id").references(() => twitchUsers.twitchUserId),
  twitchStreamId: text("twitch_stream_id").references(() => streamSessions.twitchStreamId),
  actorUserId: text("actor_user_id").references(() => twitchUsers.twitchUserId),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  source: text("source").notNull(),
  sourceEventId: text("source_event_id"),
  rawEventsubEventId: uuid("raw_eventsub_event_id").references(() => rawEventsubEvents.id),
  rawIrcMessageId: uuid("raw_irc_message_id").references(() => rawIrcMessages.id),
  ...timestamps
}, (table) => ({
  channelOccurredIdx: index("channel_events_channel_occurred_idx").on(table.broadcasterUserId, table.occurredAt),
  streamOccurredIdx: index("channel_events_stream_occurred_idx").on(table.twitchStreamId, table.occurredAt),
  sourceEventIdx: index("channel_events_source_event_idx").on(table.source, table.sourceEventId),
  sourceEventUniqueIdx: uniqueIndex("channel_events_source_event_unique_idx").on(table.source, table.eventType, table.sourceEventId)
}));

export const raids = pgTable("raids", {
  id: uuid("id").defaultRandom().primaryKey(),
  sourceBroadcasterUserId: text("source_broadcaster_user_id").references(() => twitchUsers.twitchUserId),
  targetBroadcasterUserId: text("target_broadcaster_user_id").references(() => twitchUsers.twitchUserId),
  viewerCount: integer("viewer_count"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  sourceStreamId: text("source_stream_id").references(() => streamSessions.twitchStreamId),
  targetStreamId: text("target_stream_id").references(() => streamSessions.twitchStreamId),
  rawEventsubEventId: uuid("raw_eventsub_event_id").references(() => rawEventsubEvents.id),
  ...timestamps
}, (table) => ({
  sourceStreamOccurredIdx: index("raids_source_stream_occurred_idx").on(table.sourceStreamId, table.occurredAt),
  targetStreamOccurredIdx: index("raids_target_stream_occurred_idx").on(table.targetStreamId, table.occurredAt),
  rawEventsubEventIdx: uniqueIndex("raids_raw_eventsub_event_idx").on(table.rawEventsubEventId)
}));

export const streamActivityBuckets = pgTable("stream_activity_buckets", {
  twitchStreamId: text("twitch_stream_id").notNull().references(() => streamSessions.twitchStreamId),
  bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
  bucketMinutes: integer("bucket_minutes").notNull(),
  viewerCountMin: integer("viewer_count_min"),
  viewerCountMax: integer("viewer_count_max"),
  viewerCountAvg: integer("viewer_count_avg"),
  messageCount: integer("message_count").default(0).notNull(),
  joinCount: integer("join_count").default(0).notNull(),
  partCount: integer("part_count").default(0).notNull(),
  activeChatterCount: integer("active_chatter_count"),
  eventCounts: jsonb("event_counts").$type<Record<string, number>>().default({}).notNull(),
  ...timestamps
}, (table) => ({
  pk: primaryKey({ columns: [table.twitchStreamId, table.bucketStart, table.bucketMinutes] })
}));

export const channelDailyStats = pgTable("channel_daily_stats", {
  broadcasterUserId: text("broadcaster_user_id").notNull().references(() => twitchUsers.twitchUserId),
  day: text("day").notNull(),
  streamCount: integer("stream_count").default(0).notNull(),
  liveSeconds: integer("live_seconds").default(0).notNull(),
  viewerCountMax: integer("viewer_count_max"),
  viewerCountAvg: integer("viewer_count_avg"),
  messageCount: integer("message_count").default(0).notNull(),
  aggregateEngagement: jsonb("aggregate_engagement").$type<Record<string, unknown>>().default({}).notNull(),
  ...timestamps
}, (table) => ({
  pk: primaryKey({ columns: [table.broadcasterUserId, table.day] })
}));

export const chatterChannelActivityBuckets = pgTable("chatter_channel_activity_buckets", {
  chatterUserId: text("chatter_user_id").notNull().references(() => twitchUsers.twitchUserId),
  broadcasterUserId: text("broadcaster_user_id").notNull().references(() => twitchUsers.twitchUserId),
  bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
  bucketMinutes: integer("bucket_minutes").notNull(),
  messageCount: integer("message_count").default(0).notNull(),
  firstActivityAt: timestamp("first_activity_at", { withTimezone: true }),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  activeMinutes: integer("active_minutes").default(0).notNull(),
  joinCount: integer("join_count").default(0).notNull(),
  partCount: integer("part_count").default(0).notNull(),
  emoteCounts: jsonb("emote_counts").$type<Record<string, number>>().default({}).notNull(),
  badgeObservations: jsonb("badge_observations").$type<Record<string, string>>().default({}).notNull(),
  ...timestamps
}, (table) => ({
  pk: primaryKey({ columns: [table.chatterUserId, table.broadcasterUserId, table.bucketStart, table.bucketMinutes] })
}));

export const chatterDailyStats = pgTable("chatter_daily_stats", {
  chatterUserId: text("chatter_user_id").notNull().references(() => twitchUsers.twitchUserId),
  day: text("day").notNull(),
  messageCount: integer("message_count").default(0).notNull(),
  channelsActive: integer("channels_active").default(0).notNull(),
  activeMinutes: integer("active_minutes").default(0).notNull(),
  summary: jsonb("summary").$type<Record<string, unknown>>().default({}).notNull(),
  ...timestamps
}, (table) => ({
  pk: primaryKey({ columns: [table.chatterUserId, table.day] })
}));

export const appUsers = pgTable("app_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  twitchUserId: text("twitch_user_id").notNull().references(() => twitchUsers.twitchUserId),
  isAdmin: boolean("is_admin").default(false).notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  ...timestamps
}, (table) => ({
  twitchUserIdx: uniqueIndex("app_users_twitch_user_idx").on(table.twitchUserId)
}));

export const sessions = pgTable("sessions", {
  sessionIdHash: text("session_id_hash").primaryKey(),
  appUserId: uuid("app_user_id").notNull().references(() => appUsers.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ...timestamps
});

export const oauthAccounts = pgTable("oauth_accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  appUserId: uuid("app_user_id").notNull().references(() => appUsers.id),
  provider: text("provider").default("twitch").notNull(),
  providerUserId: text("provider_user_id").notNull(),
  scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
  encryptedAccessToken: text("encrypted_access_token"),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  refreshStatus: text("refresh_status").default("unknown").notNull(),
  latestError: text("latest_error"),
  ...timestamps
}, (table) => ({
  providerUserIdx: uniqueIndex("oauth_accounts_provider_user_idx").on(table.provider, table.providerUserId)
}));

export const adminUsers = pgTable("admin_users", {
  twitchUserId: text("twitch_user_id").primaryKey().references(() => twitchUsers.twitchUserId),
  grantedBy: text("granted_by"),
  grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
  ...timestamps
});

export const privacyRequests = pgTable("privacy_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  requestType: privacyRequestTypeEnum("request_type").notNull(),
  status: privacyRequestStatusEnum("status").default("pending").notNull(),
  subjectTwitchUserId: text("subject_twitch_user_id").notNull().references(() => twitchUsers.twitchUserId),
  requestedByAppUserId: uuid("requested_by_app_user_id").references(() => appUsers.id),
  reviewedByAppUserId: uuid("reviewed_by_app_user_id").references(() => appUsers.id),
  details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  latestError: text("latest_error"),
  ...timestamps
}, (table) => ({
  subjectRequestedIdx: index("privacy_requests_subject_requested_idx").on(table.subjectTwitchUserId, table.requestedAt),
  statusRequestedIdx: index("privacy_requests_status_requested_idx").on(table.status, table.requestedAt)
}));

export const subjectPrivacyStates = pgTable("subject_privacy_states", {
  twitchUserId: text("twitch_user_id").primaryKey().references(() => twitchUsers.twitchUserId),
  publicProfileHidden: boolean("public_profile_hidden").default(false).notNull(),
  trackingOptedOut: boolean("tracking_opted_out").default(false).notNull(),
  rawDataRedactedAt: timestamp("raw_data_redacted_at", { withTimezone: true }),
  dataDeletedAt: timestamp("data_deleted_at", { withTimezone: true }),
  latestRequestId: uuid("latest_request_id").references(() => privacyRequests.id),
  ...timestamps
}, (table) => ({
  publicProfileHiddenIdx: index("subject_privacy_states_public_hidden_idx").on(table.publicProfileHidden),
  trackingOptedOutIdx: index("subject_privacy_states_tracking_opted_out_idx").on(table.trackingOptedOut)
}));

export const privacyRequestEvents = pgTable("privacy_request_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  privacyRequestId: uuid("privacy_request_id").notNull().references(() => privacyRequests.id),
  eventType: text("event_type").notNull(),
  actorAppUserId: uuid("actor_app_user_id").references(() => appUsers.id),
  details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  ...timestamps
}, (table) => ({
  requestOccurredIdx: index("privacy_request_events_request_occurred_idx").on(table.privacyRequestId, table.occurredAt)
}));

export const jobLocks = pgTable("job_locks", {
  name: text("name").primaryKey(),
  owner: text("owner").notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...timestamps
});

export const rateLimitObservations = pgTable("rate_limit_observations", {
  id: uuid("id").defaultRandom().primaryKey(),
  source: text("source").notNull(),
  endpoint: text("endpoint").notNull(),
  botAccountId: uuid("bot_account_id").references(() => botAccounts.id),
  limit: integer("limit"),
  remaining: integer("remaining"),
  resetAt: timestamp("reset_at", { withTimezone: true }),
  headers: jsonb("headers").$type<Record<string, string>>().default({}).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
  ...timestamps
});

export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerName: text("worker_name").notNull(),
  loopName: text("loop_name").notNull(),
  status: text("status").default("unknown").notNull(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).defaultNow().notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
  ...timestamps
}, (table) => ({
  pk: primaryKey({ columns: [table.workerName, table.loopName] })
}));

export const eventProcessingFailures = pgTable("event_processing_failures", {
  id: uuid("id").defaultRandom().primaryKey(),
  rawSource: text("raw_source").notNull(),
  rawId: uuid("raw_id").notNull(),
  handlerName: text("handler_name").notNull(),
  errorClass: text("error_class").notNull(),
  errorMessage: text("error_message").notNull(),
  retryCount: integer("retry_count").default(0).notNull(),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  ...timestamps
});
