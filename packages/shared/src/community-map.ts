export type CommunityNode = {
  id: string;
  chatters: number;
  /** Distinct qualifying people, including repeated chat presence. Absent in v1 snapshots. */
  participants?: number;
  community: string | null;
  x: number;
  y: number;
};
export type CommunityEdge = { source: string; target: string; shared: number; score: number };
export type CommunityGraph = { nodes: CommunityNode[]; edges: CommunityEdge[] };
export type CommunityCoverage = {
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  messages: number;
  missingSession: number;
  unknownSource: number;
  relayedMessages: number;
  qualifyingMemberships: number;
  presence?: {
    events: number;
    unresolvedEvents: number;
    recoveredEvents: number;
    observedChannels: number;
    snapshotChannels: number;
    qualifyingMemberships: number;
    presenceOnlyMemberships: number;
  };
};
export type CommunityMap = {
  recipe: string;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  coverage: CommunityCoverage;
  graph: {
    nodes: Array<CommunityNode & { login: string | null; displayName: string | null; profileImageUrl: string | null }>;
    edges: CommunityEdge[];
  };
};
export type CommunityBuildStatus = {
  status: "idle" | "queued" | "building" | "ready" | "failed";
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
};
