import Link from "next/link";
import type { ReactNode } from "react";
import { formatDateTime, formatDuration } from "../../format";
import { Avatar, EmptyState, StatusPill } from "../../ui";
import { getStreamSession } from "./stream-data";
import { StreamNavigation } from "./stream-navigation";

export default async function StreamLayout({ params, children }: { params: Promise<{ streamId: string }>; children: ReactNode }) {
  const { streamId } = await params;
  const stream = await getStreamSession(streamId);
  if (stream == null) return <section className="panel"><EmptyState title="Stream unavailable" description="This session could not be loaded. It may be unavailable or require a different account." action={<Link className="button" href="/">Live streams</Link>} /></section>;
  const name = stream.broadcasterDisplayName ?? stream.broadcasterLogin ?? "Unknown channel";
  const duration = Math.max(0, (new Date(stream.endedAt ?? stream.lastSeenLiveAt).getTime() - new Date(stream.startedAt).getTime()) / 1000);
  return <>
    <section className="page-title page-title-wide">
      <div className="breadcrumbs"><Link href="/">Live streams</Link><span>/</span>{stream.broadcasterLogin == null ? <span>{name}</span> : <Link href={`/channels/${stream.broadcasterLogin}`}>{name}</Link>}<span>/</span><span>Stream session</span></div>
      <div className="page-heading-row">
        <div className="identity-heading"><Avatar name={name} src={stream.broadcasterProfileImageUrl} size="large" /><div><span className="eyebrow">{stream.latestCategoryName ?? "Stream session"}</span><h1>{stream.latestTitle ?? "Stream session"}</h1></div></div>
        <StatusPill tone={stream.endedAt == null ? "success" : "neutral"}>{stream.endedAt == null ? "Live" : "Ended"}</StatusPill>
      </div>
      <p>{name} · {formatDateTime(stream.startedAt)} · {formatDuration(duration)} {stream.endedAt == null ? "observed" : "duration"}</p>
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
