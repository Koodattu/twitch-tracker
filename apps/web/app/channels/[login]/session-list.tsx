import Link from "next/link";
import type { ChannelSession } from "@twitch-tracker/shared";
import { formatDateTime, formatDuration } from "../../format";
import { EmptyState, StatusPill } from "../../ui";

export function ChannelSessionList({ sessions }: { sessions: ChannelSession[] }) {
  if (sessions.length === 0) return <EmptyState title="No sessions on this page" description="No observed sessions are available on this page." />;
  return <div className="channel-session-list">{sessions.map((session) => {
    const duration = Math.max(0, (new Date(session.endedAt ?? session.lastSeenLiveAt).getTime() - new Date(session.startedAt).getTime()) / 1000);
    return <article className="channel-session-card" key={session.twitchStreamId}>
      <div className="message-meta"><time dateTime={session.startedAt}>{formatDateTime(session.startedAt)}</time><StatusPill tone={session.endedAt == null ? "success" : "neutral"}>{session.endedAt == null ? "Live" : "Ended"}</StatusPill></div>
      <Link className="recent-stream-title" href={`/streams/${encodeURIComponent(session.twitchStreamId)}`} prefetch={false}>{session.latestTitle ?? "Untitled stream"}</Link>
      <div className="recent-stream-meta"><span>{session.latestCategoryName ?? "Category unavailable"}</span><span>{formatDuration(duration)} {session.endedAt == null ? "observed" : "duration"}</span></div>
    </article>;
  })}</div>;
}
