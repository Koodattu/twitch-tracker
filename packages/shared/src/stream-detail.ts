export type StreamSessionDetail = {
  twitchStreamId: string;
  broadcasterLogin: string | null;
  broadcasterDisplayName: string | null;
  broadcasterProfileImageUrl: string | null;
  latestTitle: string | null;
  latestCategoryName: string | null;
  startedAt: string;
  endedAt: string | null;
  firstSeenAt: string;
  lastSeenLiveAt: string;
  canInspectRaw: boolean;
};

export type StreamChartPoint = {
  time: string;
  viewers: number | null;
  viewerPeak: number | null;
  messagesPerMinute: number | null;
  activeChatters: number | null;
  interrupted: boolean;
};

export type StreamEvent = {
  id: string;
  eventType: string;
  occurredAt: string;
  source: string;
  actor: string | null;
  viewerCount: number | null;
};

export type StreamOverview = {
  totals: {
    viewerCountAvg: number | null;
    viewerCountMax: number | null;
    messageCount: number;
    activeChatterCountMax: number | null;
  };
  intervalMinutes: number;
  points: StreamChartPoint[];
  peakAudience: { time: string; viewers: number } | null;
  busiestChat: { time: string; messages: number; minutes: number } | null;
  largestRaid: { time: string; viewers: number } | null;
  events: StreamEvent[];
};

export type StreamDetailPage<T> = {
  items: T[];
  page: number;
  hasMore: boolean;
};

export type StreamMessage = {
  messageId: string;
  chatterLogin: string | null;
  chatterDisplayName: string | null;
  sentAt: string | null;
  receivedAt: string;
  rawText: string | null;
  source: string;
  messageType: string;
};

export type StreamObservation = {
  id: string;
  observedAt: string;
  viewerCount: number | null;
  title: string | null;
  categoryName: string | null;
};

export type StreamBucket = {
  bucketStart: string;
  bucketMinutes: number;
  viewerCountAvg: number | null;
  viewerCountMax: number | null;
  messageCount: number;
  activeChatterCount: number | null;
  joinCount: number;
  partCount: number;
  eventCounts: Record<string, number>;
};

export type StreamMembership = {
  id: string;
  eventType: string;
  source: string;
  confidence: number;
  chatterLogin: string | null;
  eventAt: string | null;
  receivedAt: string;
};

export type StreamPresence = {
  id: string;
  source: string;
  confidence: number;
  sampledAt: string;
  chatterCount: number;
  pageCount: number;
  requestStatus: string;
};
