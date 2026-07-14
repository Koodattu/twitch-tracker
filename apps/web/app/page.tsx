import type { LiveStreamSummary, RecentStreamSummary } from "@twitch-tracker/shared";
import Link from "next/link";
import { getApiData, getPublicApiInit } from "./api-client";
import { formatCount, formatDateTime, formatDuration, formatRelativeTime, getSizedThumbnailUrl } from "./format";
import { Avatar, EmptyState, MetricCard, StatusPill } from "./ui";

export default async function HomePage() {
  const apiInit = await getPublicApiInit();
  const [streamResponse, recentResponse] = await Promise.all([
    getApiData<LiveStreamSummary[]>("/api/streams/live", apiInit),
    getApiData<RecentStreamSummary[]>("/api/streams/recent?limit=6&status=ended&language=fi", apiInit)
  ]);
  const streams = streamResponse ?? [];
  const recentStreams = recentResponse ?? [];
  const featuredStreams = streams.slice(0, 4);
  const totalViewers = streams.reduce((sum, stream) => sum + (stream.viewerCount ?? 0), 0);
  const trackedStreams = streams.filter((stream) => stream.isChatTracked).length;
  const latestObservation = streams
    .map((stream) => stream.viewerObservedAt)
    .filter((value): value is string => value != null)
    .sort()
    .at(-1);
  const now = new Date();

  return (
    <>
      <section className="page-title page-title-wide">
        <span className="eyebrow">Finnish Twitch · Live</span>
        <div className="page-heading-row">
          <div>
            <h1>What’s live right now</h1>
            <p>Finnish-language streams ranked by the latest viewer snapshot, with chat coverage shown separately.</p>
          </div>
          <StatusPill tone={streams.length > 0 ? "success" : "neutral"}>{streams.length > 0 ? "Live data" : "Waiting for data"}</StatusPill>
        </div>
      </section>

      <section className="stat-row" aria-label="Live stream summary">
        <MetricCard label="Live streams" value={formatCount(streams.length)} detail="Currently classified as language: Finnish" />
        <MetricCard label="Chat tracked" value={formatCount(trackedStreams)} detail="Streams with active chat coverage" />
        <MetricCard label="Current viewers" value={formatCount(totalViewers)} detail={latestObservation == null ? "No viewer snapshot yet" : `Latest snapshot ${formatRelativeTime(latestObservation, now)}`} />
      </section>

      {featuredStreams.length === 0 ? null : (
        <section className="directory-section" aria-labelledby="top-live-heading">
          <div className="section-heading-row">
            <div className="section-heading">
              <h2 id="top-live-heading">Top live streams</h2>
              <p>Open a session for its viewer and chat-activity timeline.</p>
            </div>
            {latestObservation == null ? null : <span className="freshness-label">Updated {formatRelativeTime(latestObservation, now)}</span>}
          </div>
          <div className="live-card-grid">
            {featuredStreams.map((stream, index) => (
              <LiveStreamCard key={stream.streamId} stream={stream} rank={index + 1} now={now} priority={index === 0} />
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-header">
          <div className="panel-heading">
            <h2>Full live ranking</h2>
            <p>Viewer counts are periodic snapshots, not real-time telemetry.</p>
          </div>
          <StatusPill tone="accent">{streams.length} live</StatusPill>
        </div>

        {streamResponse == null ? (
          <EmptyState title="Live data is unavailable" description="The analytics service could not be reached. Try again shortly." />
        ) : streams.length === 0 ? (
          <EmptyState title="No live streams captured" description="No live Finnish Stream has been discovered yet." />
        ) : (
          <div className="table-scroll" role="region" aria-label="Live Finnish stream ranking" tabIndex={0}>
            <table className="table live-ranking-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Stream</th>
                  <th scope="col">Category</th>
                  <th scope="col">Viewers</th>
                  <th scope="col">Started</th>
                  <th scope="col">Chat coverage</th>
                </tr>
              </thead>
              <tbody>
                {streams.map((stream, index) => {
                  const identity = stream.broadcasterDisplayName ?? stream.broadcasterLogin ?? stream.broadcasterId;
                  return (
                    <tr key={stream.streamId}>
                      <td className="rank-cell">{index + 1}</td>
                      <td>
                        <div className="channel-cell">
                          <Avatar name={identity} src={stream.broadcasterProfileImageUrl} size="small" />
                          <div className="cell-stack">
                            {stream.broadcasterLogin == null ? (
                              <strong>{identity}</strong>
                            ) : (
                              <Link href={`/channels/${stream.broadcasterLogin}`}><strong>{identity}</strong></Link>
                            )}
                            <span>{stream.broadcasterLogin == null ? stream.broadcasterId : `@${stream.broadcasterLogin}`}</span>
                          </div>
                        </div>
                      </td>
                      <td className="message-cell">
                        <Link href={`/streams/${stream.streamId}`}><strong>{stream.title ?? "Untitled stream"}</strong></Link>
                      </td>
                      <td>{stream.categoryName ?? <span className="muted">Unknown</span>}</td>
                      <td className="number-cell"><strong>{formatCount(stream.viewerCount)}</strong></td>
                      <td className="time-cell">{formatDateTime(stream.startedAt)}</td>
                      <td><ChatCoverage stream={stream} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" id="recent-streams">
        <div className="panel-header">
          <div className="panel-heading">
            <h2>Recently ended</h2>
            <p>Continue exploring sessions after they leave the live ranking.</p>
          </div>
          <StatusPill>{recentStreams.length} sessions</StatusPill>
        </div>
        {recentResponse == null ? (
          <EmptyState title="Recent sessions are unavailable" description="Historical stream sessions could not be loaded right now." />
        ) : recentStreams.length === 0 ? (
          <EmptyState title="No ended sessions yet" description="Completed stream sessions will appear here once they have been observed." />
        ) : (
          <div className="recent-stream-grid">
            {recentStreams.map((stream) => <RecentStreamCard key={stream.streamId} stream={stream} now={now} />)}
          </div>
        )}
      </section>

      <p className="data-note">A Discovered Stream is tracked at metadata level. “Chat tracked” means the tracker currently has chat coverage; it does not identify viewers.</p>
    </>
  );
}

function LiveStreamCard({ stream, rank, now, priority }: { stream: LiveStreamSummary; rank: number; now: Date; priority: boolean }) {
  const identity = stream.broadcasterDisplayName ?? stream.broadcasterLogin ?? stream.broadcasterId;
  const thumbnailUrl = getSizedThumbnailUrl(stream.thumbnailUrl);
  const liveSeconds = Math.max(0, Math.floor((now.getTime() - new Date(stream.startedAt).getTime()) / 1000));

  return (
    <article className="live-card">
      <Link className="stream-preview" href={`/streams/${stream.streamId}`} aria-label={`Open ${identity} stream session`}>
        {thumbnailUrl == null ? <StreamPreviewPlaceholder /> : (
          <img src={thumbnailUrl} alt="" width={640} height={360} loading={priority ? "eager" : "lazy"} fetchPriority={priority ? "high" : "auto"} decoding="async" />
        )}
        <span className="stream-preview-topline" aria-hidden="true">
          <span className="live-badge">Live</span>
          <span className="rank-badge">#{rank}</span>
        </span>
        <span className="viewer-badge">{formatCount(stream.viewerCount)} viewers</span>
      </Link>
      <div className="live-card-copy">
        <div className="live-card-channel">
          <Avatar name={identity} src={stream.broadcasterProfileImageUrl} size="small" />
          <div className="cell-stack">
            {stream.broadcasterLogin == null ? <strong>{identity}</strong> : <Link href={`/channels/${stream.broadcasterLogin}`}><strong>{identity}</strong></Link>}
            <span>{stream.categoryName ?? "Category unavailable"}</span>
          </div>
        </div>
        <Link className="live-card-title" href={`/streams/${stream.streamId}`}>{stream.title ?? "Untitled stream"}</Link>
        <div className="live-card-meta">
          <span className="number-cell">Live for {formatDuration(liveSeconds)}</span>
          <ChatCoverage stream={stream} />
        </div>
      </div>
    </article>
  );
}

function RecentStreamCard({ stream, now }: { stream: RecentStreamSummary; now: Date }) {
  const identity = stream.broadcasterDisplayName ?? stream.broadcasterLogin ?? stream.broadcasterId;
  const durationEnd = stream.endedAt == null ? now : new Date(stream.endedAt);
  const durationSeconds = Math.max(0, Math.floor((durationEnd.getTime() - new Date(stream.startedAt).getTime()) / 1000));

  return (
    <article className="recent-stream-card">
      <Link className="recent-stream-preview" href={`/streams/${stream.streamId}`} aria-label={`Open ${identity} stream session`}>
        <StreamPreviewPlaceholder />
      </Link>
      <div className="recent-stream-copy">
        <div className="recent-stream-channel">
          <Avatar name={identity} src={stream.broadcasterProfileImageUrl} size="small" />
          <div className="cell-stack">
            {stream.broadcasterLogin == null ? <strong>{identity}</strong> : <Link href={`/channels/${stream.broadcasterLogin}`}><strong>{identity}</strong></Link>}
            <span>{stream.endedAt == null ? "Live now" : `Ended ${formatRelativeTime(stream.endedAt, now)}`}</span>
          </div>
        </div>
        <Link className="recent-stream-title" href={`/streams/${stream.streamId}`}>{stream.title ?? "Untitled stream"}</Link>
        <div className="recent-stream-meta"><span>{stream.categoryName ?? "Category unavailable"}</span><span className="number-cell">{formatDuration(durationSeconds)}</span></div>
      </div>
    </article>
  );
}

function StreamPreviewPlaceholder() {
  return <span className="stream-preview-placeholder" aria-hidden="true"><span /><span /><span /></span>;
}

function ChatCoverage({ stream }: { stream: LiveStreamSummary }) {
  if (stream.chatAssignmentStatus == null) {
    return <StatusPill>Chat not tracked</StatusPill>;
  }

  if (stream.chatAssignmentStatus === "joined") {
    return <StatusPill tone="success">Chat tracked</StatusPill>;
  }

  if (stream.chatAssignmentStatus === "leaving") {
    return <StatusPill tone="warning">Tracking ending</StatusPill>;
  }

  return <StatusPill tone="warning">Tracking starting</StatusPill>;
}
