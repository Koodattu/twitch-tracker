import Link from "next/link";
import type { ReactNode } from "react";
import { formatDateTime, formatDuration } from "../../format";
import { Avatar, EmptyState } from "../../ui";
import { StreamStatusBadge } from "../../stream-status-badge";
import { getStreamStatus, recentObservationMinutes } from "../../stream-status";
import { RetryButton } from "../../retry-button";
import { getStreamSession } from "./stream-data";
import { StreamNavigation } from "./stream-navigation";
import { StreamReturnLink } from "./stream-return-link";

export default async function StreamLayout({ params, children }: { params: Promise<{ streamId: string }>; children: ReactNode }) {
  const { streamId } = await params;
  const stream = await getStreamSession(streamId);
  if (stream == null) return <section className="panel"><EmptyState title="Stream unavailable" description="This session could not be loaded. Try again, or check whether you need a different account." action={<RetryButton />} /></section>;
  const name = stream.broadcasterDisplayName ?? stream.broadcasterLogin ?? "Unknown channel";
  const now = new Date();
  const status = getStreamStatus(stream, now);
  const duration = Math.max(0, (new Date(stream.endedAt ?? stream.lastSeenLiveAt).getTime() - new Date(stream.startedAt).getTime()) / 1000);
  return <>
    <section className="page-title page-title-wide stream-page-title">
      <div className="breadcrumbs"><StreamReturnLink login={stream.broadcasterLogin} /><span>/</span>{stream.broadcasterLogin == null ? <span>{name}</span> : <Link href={`/channels/${stream.broadcasterLogin}`}>{name}</Link>}<span>/</span><span>Stream session</span></div>
      <div className="page-heading-row">
        <h1>{stream.latestTitle ?? "Stream session"}</h1>
        <StreamStatusBadge stream={stream} now={now} />
      </div>
      <div className="stream-session-context"><Avatar name={name} src={stream.broadcasterProfileImageUrl} size="small" /><p>{name}{stream.latestCategoryName == null ? "" : ` · ${stream.latestCategoryName}`} · {formatDateTime(stream.startedAt)} · {formatDuration(duration)} {stream.endedAt == null ? "observed" : "duration"}</p></div>
      {stream.endedAt == null ? <div className="observation-notice">
        <div><strong>{status === "unconfirmed" ? "Live status is unconfirmed" : "Live at the last observation"}</strong><p>Last seen <time dateTime={stream.lastSeenLiveAt}>{formatDateTime(stream.lastSeenLiveAt)}</time>. {status === "unconfirmed" ? `No live observation in the last ${recentObservationMinutes} minutes; this stream may have ended.` : "This is a snapshot, not a live connection."}</p></div>
        <RetryButton label="Refresh data" pendingLabel="Refreshing…" />
      </div> : null}
      <details className="stream-session-details"><summary>Session details</summary><dl>
        <div><dt>Twitch started</dt><dd>{formatDateTime(stream.startedAt)}</dd></div>
        <div><dt>First discovered</dt><dd>{formatDateTime(stream.firstSeenAt)}</dd></div>
        <div><dt>Last seen live</dt><dd>{formatDateTime(stream.lastSeenLiveAt)}</dd></div>
        <div><dt>Ended</dt><dd>{stream.endedAt == null ? "Still live or awaiting confirmation" : formatDateTime(stream.endedAt)}</dd></div>
        <div><dt>Stream ID</dt><dd>{streamId}</dd></div>
      </dl></details>
    </section>
    <StreamNavigation streamId={streamId} canInspectRaw={stream.canInspectRaw} />
    {children}
  </>;
}
