import { describe, expect, it } from "vitest";
import {
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
