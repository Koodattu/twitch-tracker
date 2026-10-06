import { describe, expect, it } from "vitest";
import type { LiveStreamSummary } from "@twitch-tracker/shared";
import { getStreamStatus, isRecentObservation, summarizeLiveObservations } from "./stream-status";

const now = new Date("2026-10-06T12:00:00Z");
const recent = "2026-10-06T11:58:00Z";
const old = "2026-10-06T09:00:00Z";
const stream = (overrides: Partial<LiveStreamSummary> = {}): LiveStreamSummary => ({
  streamId: "test", broadcasterId: "channel", broadcasterLogin: "channel", broadcasterDisplayName: null,
  broadcasterProfileImageUrl: null, title: null, categoryName: null, language: "fi", finnishMatchReason: "language",
  viewerCount: 100, viewerObservedAt: recent, thumbnailUrl: null, startedAt: old, firstSeenAt: old,
  lastSeenLiveAt: recent, chatAssignmentStatus: "joined", isChatTracked: true, ...overrides
});

describe("live observation meaning", () => {
  it("separates a confirmed ending from an old or missing live observation", () => {
    expect(getStreamStatus({ endedAt: recent, lastSeenLiveAt: recent }, now)).toBe("ended");
    expect(getStreamStatus({ endedAt: null, lastSeenLiveAt: recent }, now)).toBe("recent");
    expect(getStreamStatus({ endedAt: null, lastSeenLiveAt: old }, now)).toBe("unconfirmed");
    expect(getStreamStatus({}, now)).toBe("unconfirmed");
  });
  it("allows two known-channel scan intervals, but rejects invalid and future observations", () => {
    expect(isRecentObservation("2026-10-06T11:30:00Z", now)).toBe(true);
    expect(isRecentObservation("2026-10-06T11:29:59Z", now)).toBe(false);
    expect(isRecentObservation("2026-10-06T12:00:30Z", now)).toBe(true);
    expect(isRecentObservation("2026-10-06T12:02:00Z", now)).toBe(false);
    expect(isRecentObservation("invalid", now)).toBe(false);
  });
  it("counts only recent viewer samples and reports their denominator", () => {
    const result = summarizeLiveObservations([
      stream(), stream({ viewerCount: 200, lastSeenLiveAt: old, viewerObservedAt: old }),
      stream({ viewerCount: null, viewerObservedAt: null, isChatTracked: false }),
      stream({ viewerCount: 0, isChatTracked: false }), stream({ viewerCount: 300, viewerObservedAt: old })
    ], now);
    expect(result).toEqual({ recentCount: 4, unconfirmedCount: 1, viewerSampleCount: 2, viewerCount: 100, chatTrackedCount: 2 });
  });
  it("preserves observed zero and never turns missing, stale or empty observations into zero viewers", () => {
    expect(summarizeLiveObservations([stream({ viewerCount: 0 })], now).viewerCount).toBe(0);
    for (const streams of [[], [stream({ viewerCount: null })], [stream({ lastSeenLiveAt: old })]]) {
      expect(summarizeLiveObservations(streams, now).viewerCount).toBeNull();
    }
  });
});
