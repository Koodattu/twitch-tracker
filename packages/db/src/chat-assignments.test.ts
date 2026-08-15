import { describe, expect, it } from "vitest";
import {
  allocatePoolAssignmentCandidates,
  reduceEffectiveAssignmentStatuses,
  selectStableAssignmentCandidates,
  type AssignmentCandidate
} from "./chat-assignments.js";

const observedAt = new Date("2026-08-09T12:00:00.000Z");

const candidate = (
  twitchStreamId: string,
  viewerCount: number,
  overrides: Partial<AssignmentCandidate> = {}
): AssignmentCandidate => ({
  twitchStreamId,
  broadcasterUserId: `user-${twitchStreamId}`,
  viewerCount,
  lastSeenLiveAt: observedAt,
  isManuallyPinned: false,
  isOptedIn: false,
  isKnownModerator: false,
  trackingPriority: 0,
  ...overrides
});

describe("Chat Assignment selection", () => {
  it("puts manual pins and authorized channels ahead of viewer rank", () => {
    const selected = selectStableAssignmentCandidates({
      candidates: [
        candidate("popular", 1_000),
        candidate("authorized", 10, { isKnownModerator: true }),
        candidate("pinned", 1, { isManuallyPinned: true })
      ],
      incumbentStreamIds: new Set(),
      capacity: 3
    });

    expect(selected.map((item) => item.twitchStreamId)).toEqual(["pinned", "authorized", "popular"]);
  });

  it("preserves an incumbent when a viewer-only challenger is not clearly better", () => {
    const selected = selectStableAssignmentCandidates({
      candidates: [candidate("challenger", 115), candidate("incumbent", 100)],
      incumbentStreamIds: new Set(["incumbent"]),
      capacity: 1
    });

    expect(selected.map((item) => item.twitchStreamId)).toEqual(["incumbent"]);
  });

  it("replaces an incumbent after the viewer hysteresis is crossed", () => {
    const selected = selectStableAssignmentCandidates({
      candidates: [candidate("challenger", 125), candidate("incumbent", 100)],
      incumbentStreamIds: new Set(["incumbent"]),
      capacity: 1
    });

    expect(selected.map((item) => item.twitchStreamId)).toEqual(["challenger"]);
  });

  it("lets a higher priority class replace an incumbent immediately", () => {
    const selected = selectStableAssignmentCandidates({
      candidates: [
        candidate("authorized", 1, { isOptedIn: true }),
        candidate("incumbent", 1_000)
      ],
      incumbentStreamIds: new Set(["incumbent"]),
      capacity: 1
    });

    expect(selected.map((item) => item.twitchStreamId)).toEqual(["authorized"]);
  });

  it("deduplicates Twitch Stream candidates and respects zero capacity", () => {
    const duplicate = candidate("same", 20);
    expect(selectStableAssignmentCandidates({
      candidates: [duplicate, { ...duplicate, viewerCount: 10 }],
      incumbentStreamIds: new Set(),
      capacity: 1
    })).toHaveLength(1);
    expect(selectStableAssignmentCandidates({
      candidates: [duplicate],
      incumbentStreamIds: new Set(),
      capacity: 0
    })).toEqual([]);
  });

  it("allocates distinct candidates across the full bot account pool", () => {
    const allocations = allocatePoolAssignmentCandidates({
      accounts: [
        { botAccountId: "bot-1", capacity: 2 },
        { botAccountId: "bot-2", capacity: 2 },
        { botAccountId: "bot-3", capacity: 2 }
      ],
      candidates: Array.from({ length: 7 }, (_, index) => candidate(`stream-${index + 1}`, 100 - index)),
      incumbentStreamIdsByAccount: new Map()
    });

    expect(allocations.get("bot-1")?.map((item) => item.twitchStreamId)).toEqual(["stream-1", "stream-2"]);
    expect(allocations.get("bot-2")?.map((item) => item.twitchStreamId)).toEqual(["stream-3", "stream-4"]);
    expect(allocations.get("bot-3")?.map((item) => item.twitchStreamId)).toEqual(["stream-5", "stream-6"]);
    expect(new Set([...allocations.values()].flat().map((item) => item.twitchStreamId)).size).toBe(6);
  });

  it("keeps selected incumbents on their current bot accounts", () => {
    const allocations = allocatePoolAssignmentCandidates({
      accounts: [
        { botAccountId: "bot-1", capacity: 1 },
        { botAccountId: "bot-2", capacity: 1 }
      ],
      candidates: [candidate("popular", 100), candidate("incumbent", 95)],
      incumbentStreamIdsByAccount: new Map([
        ["bot-1", new Set()],
        ["bot-2", new Set(["incumbent"])]
      ])
    });

    expect(allocations.get("bot-1")?.map((item) => item.twitchStreamId)).toEqual(["popular"]);
    expect(allocations.get("bot-2")?.map((item) => item.twitchStreamId)).toEqual(["incumbent"]);
  });
});

describe("effective Chat Assignment status", () => {
  it("uses the strongest active status and ignores terminal assignments", () => {
    const statuses = reduceEffectiveAssignmentStatuses([
      { twitchStreamId: "stream-1", status: "leaving" },
      { twitchStreamId: "stream-1", status: "joining" },
      { twitchStreamId: "stream-1", status: "joined" },
      { twitchStreamId: "stream-2", status: "left" },
      { twitchStreamId: null, status: "joined" }
    ]);

    expect([...statuses.entries()]).toEqual([["stream-1", "joined"]]);
  });
});
