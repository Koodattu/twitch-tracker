import type { LiveStreamSummary } from "@twitch-tracker/shared";
import Link from "next/link";
import { getApiData, getAuthenticatedApiInit } from "./api-client";
import { formatCount, formatDateTime, formatStatus } from "./format";
import { Avatar, EmptyState, MetricCard, StatusPill } from "./ui";

export default async function HomePage() {
  const apiInit = await getAuthenticatedApiInit();
  const streamResponse = await getApiData<LiveStreamSummary[]>("/api/streams/live", apiInit);
  const streams = streamResponse ?? [];
  const totalViewers = streams.reduce((sum, stream) => sum + (stream.viewerCount ?? 0), 0);
  const trackedStreams = streams.filter((stream) => stream.isChatTracked).length;
  const latestObservation = streams
    .map((stream) => stream.viewerObservedAt)
    .filter((value): value is string => value != null)
    .sort()
    .at(-1);

  return (
    <>
      <section className="page-title page-title-wide">
        <span className="eyebrow">Finnish Twitch · Live</span>
        <div className="page-heading-row">
          <div>
            <h1>What’s live right now</h1>
            <p>Finnish-language streams ranked by the latest viewer snapshot, with honest chat coverage at a glance.</p>
          </div>
          <StatusPill tone={streams.length > 0 ? "success" : "neutral"}>{streams.length > 0 ? "Live data" : "Waiting for data"}</StatusPill>
        </div>
      </section>

      <section className="stat-row" aria-label="Live stream summary">
        <MetricCard label="Live streams" value={formatCount(streams.length)} detail="Currently classified as language: Finnish" />
        <MetricCard label="Chat tracked" value={formatCount(trackedStreams)} detail="Rooms with an active chat assignment" />
        <MetricCard label="Current viewers" value={formatCount(totalViewers)} detail={latestObservation == null ? "No viewer snapshot yet" : `Snapshot ${formatDateTime(latestObservation)}`} />
      </section>

      <section className="panel">
        <div className="panel-header">
          <div className="panel-heading">
            <h2>Live ranking</h2>
            <p>Viewer counts are snapshots, not real-time telemetry.</p>
          </div>
          <StatusPill tone="accent">Finnish-language</StatusPill>
        </div>

        {streamResponse == null ? (
          <EmptyState title="Live data is unavailable" description="The analytics API could not be reached. The page will recover when the service is available." />
        ) : streams.length === 0 ? (
          <EmptyState title="No live streams captured" description="The discovery worker has not stored a live Finnish-language stream yet." />
        ) : (
          <div className="table-scroll" role="region" aria-label="Live Finnish stream ranking" tabIndex={0}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Stream</th>
                  <th scope="col">Category</th>
                  <th scope="col">Viewers</th>
                  <th scope="col">Started</th>
                  <th scope="col">Coverage</th>
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

      <p className="data-note">A Discovered Stream is tracked at metadata level. “Chat tracked” only means the tracker is currently assigned to that chat room; it does not identify viewers.</p>
    </>
  );
}

function ChatCoverage({ stream }: { stream: LiveStreamSummary }) {
  if (stream.chatAssignmentStatus == null) {
    return <StatusPill>Not assigned</StatusPill>;
  }

  if (stream.chatAssignmentStatus === "joined") {
    return <StatusPill tone="success">Chat tracked</StatusPill>;
  }

  return <StatusPill tone="warning">{formatStatus(stream.chatAssignmentStatus)}</StatusPill>;
}
