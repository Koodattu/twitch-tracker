export type * from "./stream-detail.js";
export type * from "./channel-detail.js";
export type * from "./community-map.js";

export const communityMapRecipe = "finnish-presence-v4";
export const channelPeriodDays = [7, 30, 90] as const;
export type ChannelPeriodDays = typeof channelPeriodDays[number];
export const earliestChannelPeriodEnd = "2011-01-01";

/** Whole UTC dates; the preceding year supports periods ending in early 2011. */
export function isChannelDay(value: unknown, today = new Date().toISOString().slice(0, 10)): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && value >= "2010-10-04" && value <= today
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export const communityMapThresholds = { channelPeople: 5, sharedPeople: 3 } as const;
export const communityNodeRadius = (people: number) => Math.min(17, 3 + Math.sqrt(people) * 0.6);

export const appModes = ["local", "private_mvp", "production"] as const;

export type AppMode = (typeof appModes)[number];

export type ApiEnvelope<T> = {
  data: T;
};

export type ApiErrorEnvelope = {
  error: {
    code: string;
    message: string;
  };
};

export type LiveStreamSummary = {
  streamId: string;
  broadcasterId: string;
  broadcasterLogin: string | null;
  broadcasterDisplayName: string | null;
  broadcasterProfileImageUrl: string | null;
  title: string | null;
  categoryName: string | null;
  language: string | null;
  finnishMatchReason: "language" | "tag" | "manual";
  viewerCount: number | null;
  viewerObservedAt: string | null;
  thumbnailUrl: string | null;
  startedAt: string;
  firstSeenAt: string;
  lastSeenLiveAt: string;
  chatAssignmentStatus: "desired" | "joining" | "joined" | "leaving" | null;
  isChatTracked: boolean;
};

export type RecentStreamSummary = {
  streamId: string;
  broadcasterId: string;
  broadcasterLogin: string | null;
  broadcasterDisplayName: string | null;
  broadcasterProfileImageUrl: string | null;
  title: string | null;
  categoryName: string | null;
  finnishMatchReason: "language" | "tag" | "manual";
  startedAt: string;
  endedAt: string | null;
  thumbnailUrl: string | null;
};

export function getSizedThumbnailUrl(value: string | null | undefined, width = 640, height = 360) {
  if (value == null || value === "") {
    return null;
  }

  return value
    .replaceAll("%{width}", String(width)).replaceAll("%{height}", String(height))
    .replaceAll("{width}", String(width)).replaceAll("{height}", String(height));
}

export type ChannelSummary = {
  twitchUserId: string;
  login: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  hasBeenSeenFinnish: boolean;
  isManuallyPinned: boolean;
  isKnownModerator: boolean;
  trackingPriority: number;
};

export type InternalIngestionStatus = {
  mode: AppMode;
  workerHeartbeats: Array<{
    workerName: string;
    loopName: string;
    status: string;
    lastHeartbeatAt: string;
  }>;
  activeAssignments: number;
  recentRuns: Array<{
    jobType: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
  }>;
  eventSubSubscriptions: Array<{
    status: string;
    desired: boolean;
    count: number;
  }>;
};
