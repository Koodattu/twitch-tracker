import type { StreamBucket, StreamObservation } from "./stream-detail.js";

export type ChannelProfile = {
  twitchUserId: string;
  login: string | null;
  displayName: string | null;
  description: string | null;
  profileImageUrl: string | null;
};

export type ChannelSession = {
  twitchStreamId: string;
  latestTitle: string | null;
  latestCategoryName: string | null;
  latestCategoryId: string | null;
  startedAt: string;
  endedAt: string | null;
  lastSeenLiveAt: string;
};

export type ChannelDay = {
  day: string;
  streamCount: number;
  liveSeconds: number;
  viewerCountMax: number | null;
  viewerCountAvg: number | null;
  messageCount: number;
};

export type ChannelOverview = {
  fromDay: string;
  toDay: string;
  daily: ChannelDay[];
  totals: {
    streamCount: number;
    liveSeconds: number;
    viewerCountMax: number | null;
    viewerCountAvg: number | null;
    messageCount: number;
  } | null;
  liveSession: ChannelSession | null;
  recentSessions: ChannelSession[];
  topCategories: ChannelCategory[];
  categoryCount: number;
  categorySeconds: number;
  viewerSeconds: number;
  observationGapSeconds: number;
};

export type ChannelCategory = {
  id: string;
  name: string;
  liveSeconds: number;
  viewerCountAvg: number | null;
};

export type ChannelObservation = StreamObservation & { twitchStreamId: string };
export type ChannelBucket = StreamBucket & { twitchStreamId: string };
