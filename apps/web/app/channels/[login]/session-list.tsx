import Link from "next/link";
import type { ChannelSession } from "@twitch-tracker/shared";
import { formatDateTime, formatDuration, formatRelativeTime } from "../../format";
import { EmptyState } from "../../ui";
import { StreamStatusBadge } from "../../stream-status-badge";
import { channelStreamHref } from "../../channel-return";

export function ChannelSessionList({ sessions, returnTo }: { sessions: ChannelSession[]; returnTo: string }) {
  const now = new Date();
  if (sessions.length === 0) return <EmptyState title="No sessions on this page" description="No observed sessions are available on this page." />;
  return <div className="channel-session-list">{sessions.map((session) => {
    const duration = Math.max(0, (new Date(session.endedAt ?? session.lastSeenLiveAt).getTime() - new Date(session.startedAt).getTime()) / 1000);
    return <article className="channel-session-card" key={session.twitchStreamId}>
      <div className="message-meta"><time dateTime={session.startedAt}>{formatDateTime(session.startedAt)}</time><StreamStatusBadge stream={session} now={now} /></div>
      <Link className="recent-stream-title" href={channelStreamHref(session.twitchStreamId, returnTo)} prefetch={false}>{session.latestTitle ?? "Untitled stream"}</Link>
      <div className="recent-stream-meta"><span>{session.latestCategoryName ?? "Category unavailable"}</span><span>{formatDuration(duration)} {session.endedAt == null ? "observed" : "duration"}</span></div>
      {session.endedAt == null ? <p className="channel-caption">Last seen live {formatRelativeTime(session.lastSeenLiveAt, now)}</p> : null}
    </article>;
  })}</div>;
}
