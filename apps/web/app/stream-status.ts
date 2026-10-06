import type { LiveStreamSummary } from "@twitch-tracker/shared";

// Known Finnish-tagged channels are scanned every 15 minutes by default.
// Two scan intervals allow for a missed observation without claiming an ending.
export const recentObservationMinutes = 30;

export function isRecentObservation(value: string | null | undefined, now: Date) {
  if (value == null) return false;
  const age = now.getTime() - Date.parse(value);
  return Number.isFinite(age) && age >= -60_000 && age <= recentObservationMinutes * 60_000;
}

export function getStreamStatus(stream: { endedAt?: string | null; lastSeenLiveAt?: string | null }, now: Date) {
  if (stream.endedAt != null) return "ended";
  return isRecentObservation(stream.lastSeenLiveAt, now) ? "recent" : "unconfirmed";
}

export function summarizeLiveObservations(streams: LiveStreamSummary[], now: Date) {
  const recent = streams.filter((stream) => isRecentObservation(stream.lastSeenLiveAt, now));
  const withViewers = recent.filter((stream) => stream.viewerCount != null && isRecentObservation(stream.viewerObservedAt, now));
  return {
    recentCount: recent.length,
    unconfirmedCount: streams.length - recent.length,
    viewerSampleCount: withViewers.length,
    viewerCount: withViewers.length === 0 ? null : withViewers.reduce((sum, stream) => sum + stream.viewerCount!, 0),
    chatTrackedCount: recent.filter((stream) => stream.isChatTracked).length
  };
}
