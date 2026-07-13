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
  viewerCount: number | null;
  viewerObservedAt: string | null;
  startedAt: string;
  firstSeenAt: string;
  lastSeenLiveAt: string;
  chatAssignmentStatus: "desired" | "joining" | "joined" | "leaving" | null;
  isChatTracked: boolean;
};

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
    count: number;
  }>;
};
