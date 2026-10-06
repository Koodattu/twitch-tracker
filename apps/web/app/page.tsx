import type { LiveStreamSummary, RecentStreamSummary } from "@twitch-tracker/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getApiData, getDetailPageNumber, getPublicApiInit } from "./api-client";
import { formatCount, formatDateTime, formatDuration, formatRelativeTime, getSizedThumbnailUrl } from "./format";
import { Avatar, EmptyState, StatusPill } from "./ui";
import { StreamThumbnail } from "./stream-thumbnail";
import { RetryButton } from "./retry-button";
import { isRecentObservation, recentObservationMinutes, summarizeLiveObservations } from "./stream-status";
import { StreamStatusBadge } from "./stream-status-badge";
import { ChannelSearch } from "./channel-search";

export const metadata: Metadata = { title: "Live streams" };

export default async function HomePage({ searchParams }: { searchParams: Promise<{ page?: string | string[]; q?: string | string[] }> }) {
  const search = await searchParams;
  const query = typeof search.q === "string" ? search.q.trim().slice(0, 100) : "";
  if (query !== "") redirect(`/channels?${new URLSearchParams({ q: query })}`);
  // A revalidated fetch can serve arbitrarily old data on the first visit after idle.
  const apiInit = { ...await getPublicApiInit(), cache: "no-store" as const };
  const [streamResponse, recentResponse] = await Promise.all([
    getApiData<LiveStreamSummary[]>("/api/streams/live", apiInit),
    getApiData<RecentStreamSummary[]>("/api/streams/recent?limit=6&status=ended&finnish=true", apiInit)
  ]);
  const streams = streamResponse ?? [];
  const recentStreams = recentResponse ?? [];
  const streamsAvailable = streamResponse != null;
  const now = new Date();
  const featuredStreams = streams.filter((stream) => isRecentObservation(stream.lastSeenLiveAt, now)).slice(0, 4);
  const pageSize = 100;
  const totalPages = Math.max(1, Math.ceil(streams.length / pageSize));
  const page = Math.min(totalPages, getDetailPageNumber(typeof search.page === "string" ? search.page : undefined));
  const pageOffset = (page - 1) * pageSize;
  const rankedStreams = streams.slice(pageOffset, pageOffset + pageSize);
  const pageHref = (target: number) => `/?page=${target}#live-ranking`;
  const summary = summarizeLiveObservations(streams, now);

  return (
    <>
      <section className="live-page-header" aria-label="Live streams and channel search">
        <div className="page-title">
          <h1>Live streams</h1>
          <p>Finnish streams, ranked by viewers.</p>
        </div>
        {streamsAvailable ? <dl className="live-header-stats" aria-label="Live stream summary">
          <div><dt>Recently live</dt><dd>{formatCount(summary.recentCount)}</dd></div>
          <div><dt>Chat assigned</dt><dd>{formatCount(summary.chatTrackedCount)}</dd></div>
          <div><dt>Observed viewers</dt><dd>{formatCount(summary.viewerCount)}
            {summary.viewerSampleCount < summary.recentCount ? <span className="live-sample-count">{summary.viewerSampleCount} of {summary.recentCount} sampled</span> : null}</dd>
          </div>
        </dl> : <StatusPill tone="danger">Live data unavailable</StatusPill>}
        <ChannelSearch />
      </section>

      {featuredStreams.length === 0 ? null : (
        <section className="directory-section" aria-labelledby="top-live-heading">
          <h2 id="top-live-heading">Top streams right now</h2>
          <div className="live-card-grid">
            {featuredStreams.map((stream, index) => (
              <LiveStreamCard key={stream.streamId} stream={stream} rank={index + 1} now={now} priority={index === 0} />
            ))}
          </div>
        </section>
      )}

      <section className="panel" id="live-ranking">
        <div className="panel-header">
          <div className="panel-heading">
            <h2>Latest stream ranking</h2>
          </div>
          <StatusPill tone={streamsAvailable ? "accent" : "danger"}>{streamsAvailable ? `${streams.length} sessions` : "Unavailable"}</StatusPill>
        </div>

        {streamResponse == null ? (
          <EmptyState title="Live data is unavailable" description="The analytics service could not be reached. Try loading it again." action={<RetryButton />} />
        ) : streams.length === 0 ? (
          <EmptyState title="No streams currently listed" description="No Finnish stream is currently listed as live. Browse channels for past streams." />
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
                {rankedStreams.map((stream, index) => {
                  const identity = stream.broadcasterDisplayName ?? stream.broadcasterLogin ?? stream.broadcasterId;
                  return (
                    <tr key={stream.streamId}>
                      <td className="rank-cell">{pageOffset + index + 1}</td>
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
                            <StreamStatusBadge stream={stream} now={now} />
                          </div>
                        </div>
                      </td>
                      <td className="message-cell">
                        <div className="cell-stack">
                          <Link href={`/streams/${stream.streamId}`}><strong>{stream.title ?? "Untitled stream"}</strong></Link>
                          <span>{formatFinnishMatchReason(stream.finnishMatchReason)}</span>
                        </div>
                      </td>
                      <td>{stream.categoryName ?? <span className="muted">Unknown</span>}</td>
                      <td className="number-cell"><div className="cell-stack"><strong>{formatCount(stream.viewerCount)}</strong><span>{stream.viewerObservedAt == null ? "No sample" : `${formatRelativeTime(stream.viewerObservedAt, now)}${isRecentObservation(stream.viewerObservedAt, now) ? "" : " · old sample"}`}</span></div></td>
                      <td className="time-cell"><div className="cell-stack"><time dateTime={stream.startedAt}>{formatDateTime(stream.startedAt)}</time><span>Seen live {formatRelativeTime(stream.lastSeenLiveAt, now)}</span></div></td>
                      <td><ChatCoverage stream={stream} now={now} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {totalPages > 1 ? (
          <nav className="pagination" aria-label="Live ranking pages">
            <span>Page {page} of {totalPages} · {formatCount(streams.length)} sessions</span>
            <div className="pagination-actions">
              {page > 1 ? <Link className="button button-secondary button-compact" href={pageHref(page - 1)} prefetch={false}>Previous</Link> : null}
              {page < totalPages ? <Link className="button button-secondary button-compact" href={pageHref(page + 1)} prefetch={false}>Next</Link> : null}
            </div>
          </nav>
        ) : null}
      </section>

      <section className="panel" id="recent-streams">
        <div className="panel-header">
          <div className="panel-heading">
            <h2>Recently ended</h2>
          </div>
          <StatusPill tone={recentResponse == null ? "danger" : "neutral"}>{recentResponse == null ? "Unavailable" : `${recentStreams.length} sessions`}</StatusPill>
        </div>
        {recentResponse == null ? (
          <EmptyState title="Recent sessions are unavailable" description="Historical stream sessions could not be loaded right now." action={<RetryButton />} />
        ) : recentStreams.length === 0 ? (
          <EmptyState title="No ended sessions yet" description="Completed stream sessions will appear here once they have been observed." />
        ) : (
          <div className="recent-stream-grid">
            {recentStreams.map((stream) => <RecentStreamCard key={stream.streamId} stream={stream} now={now} />)}
          </div>
        )}
      </section>

      <p className="data-note">Live status and viewer totals use observations from the last {recentObservationMinutes} minutes. Chat assignment does not guarantee complete capture.</p>
    </>
  );
}

function LiveStreamCard({ stream, rank, now, priority }: { stream: LiveStreamSummary; rank: number; now: Date; priority: boolean }) {
  const identity = stream.broadcasterDisplayName ?? stream.broadcasterLogin ?? stream.broadcasterId;
  const thumbnailUrl = getSizedThumbnailUrl(stream.thumbnailUrl);
  const viewerCount = isRecentObservation(stream.viewerObservedAt, now) ? stream.viewerCount : null;

  return (
    <article className="live-card">
      <Link className="stream-preview" href={`/streams/${stream.streamId}`} aria-label={`Open ${identity} stream session`}>
        <StreamThumbnail src={thumbnailUrl} priority={priority} />
        <span className="stream-preview-topline">
          <span className="rank-badge">#{rank}</span>
        </span>
        <span className="viewer-badge">{formatCount(viewerCount)} viewers</span>
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
        <StreamThumbnail src={getSizedThumbnailUrl(stream.thumbnailUrl)} />
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

const formatFinnishMatchReason = (reason: LiveStreamSummary["finnishMatchReason"]) => {
  if (reason === "tag") {
    return "Finnish tag";
  }
  if (reason === "manual") {
    return "Manually included";
  }
  return "Finnish language";
};

function ChatCoverage({ stream, now }: { stream: LiveStreamSummary; now: Date }) {
  if (!isRecentObservation(stream.lastSeenLiveAt, now)) {
    return <StatusPill tone="warning">Coverage unconfirmed</StatusPill>;
  }
  if (stream.chatAssignmentStatus == null) {
    return <StatusPill>Chat not tracked</StatusPill>;
  }

  if (stream.chatAssignmentStatus === "joined") {
    return <StatusPill tone="success">Chat assigned</StatusPill>;
  }

  if (stream.chatAssignmentStatus === "leaving") {
    return <StatusPill tone="warning">Tracking ending</StatusPill>;
  }

  return <StatusPill tone="warning">Tracking starting</StatusPill>;
}
