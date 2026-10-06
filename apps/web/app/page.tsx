import type { LiveStreamSummary, RecentStreamSummary } from "@twitch-tracker/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { getApiData, getDetailPageNumber, getPublicApiInit } from "./api-client";
import { formatCount, formatDateTime, formatDuration, formatRelativeTime, getSizedThumbnailUrl } from "./format";
import { Avatar, EmptyState, MetricCard, StatusPill } from "./ui";
import { StreamThumbnail } from "./stream-thumbnail";
import { RetryButton } from "./retry-button";
import { isRecentObservation, recentObservationMinutes, summarizeLiveObservations } from "./stream-status";
import { StreamStatusBadge } from "./stream-status-badge";

export const metadata: Metadata = { title: "Live streams" };

export default async function HomePage({ searchParams }: { searchParams: Promise<{ page?: string | string[]; q?: string | string[] }> }) {
  const search = await searchParams;
  const query = typeof search.q === "string" ? search.q.trim().slice(0, 100) : "";
  const normalizedQuery = query.toLowerCase();
  // A revalidated fetch can serve arbitrarily old data on the first visit after idle.
  const apiInit = { ...await getPublicApiInit(), cache: "no-store" as const };
  const [streamResponse, recentResponse] = await Promise.all([
    getApiData<LiveStreamSummary[]>("/api/streams/live", apiInit),
    getApiData<RecentStreamSummary[]>("/api/streams/recent?limit=6&status=ended&finnish=true", apiInit)
  ]);
  const streams = streamResponse ?? [];
  const recentStreams = recentResponse ?? [];
  const streamsAvailable = streamResponse != null;
  const featuredStreams = query === "" ? streams.slice(0, 4) : [];
  const matchingStreams = streams.map((stream, index) => ({ stream, rank: index + 1 })).filter(({ stream }) =>
    query === "" || [stream.broadcasterDisplayName, stream.broadcasterLogin, stream.title, stream.categoryName]
      .some((value) => value?.toLowerCase().includes(normalizedQuery)));
  const pageSize = 100;
  const totalPages = Math.max(1, Math.ceil(matchingStreams.length / pageSize));
  const page = Math.min(totalPages, getDetailPageNumber(typeof search.page === "string" ? search.page : undefined));
  const pageOffset = (page - 1) * pageSize;
  const rankedStreams = matchingStreams.slice(pageOffset, pageOffset + pageSize);
  const pageHref = (target: number) => `/?${new URLSearchParams({ ...(query === "" ? {} : { q: query }), page: String(target) })}#live-ranking`;
  const latestObservation = streams
    .map((stream) => stream.lastSeenLiveAt)
    .filter((value): value is string => value != null)
    .sort()
    .at(-1);
  const now = new Date();
  const summary = summarizeLiveObservations(streams, now);

  return (
    <>
      <section className="page-title page-title-wide">
        <div className="page-heading-row">
          <div>
            <h1>Live streams</h1>
            <p>Finnish streams, ranked by their last observed viewer count.</p>
          </div>
          {streamsAvailable ? null : <StatusPill tone="danger">Unavailable</StatusPill>}
        </div>
      </section>

      <div className="directory-search">
      <form className="live-search" role="search" action="/#live-ranking" method="get">
        <label htmlFor="live-search">Search live streams</label>
        <div className="live-search-controls">
          <input className="search-input" id="live-search" type="search" name="q" defaultValue={query} key={query} maxLength={100} placeholder="Channel, stream title or category" />
          <button className="button" type="submit">Search</button>
          {query === "" ? null : <Link className="button button-secondary" href="/#live-ranking" prefetch={false}>Clear search</Link>}
        </div>
      </form>
      <p className="channel-search-handoff">Looking for a channel’s past streams? <Link href={`/channels${query === "" ? "" : `?${new URLSearchParams({ q: query })}`}`} prefetch={false}>Search all channels</Link></p>
      </div>

      {streamsAvailable ? (
        <section className="stat-row live-summary" aria-label="Live stream summary">
          <MetricCard label="Recently live" value={formatCount(summary.recentCount)} detail={`Seen live within ${recentObservationMinutes} minutes`} />
          <MetricCard label="Chat assigned" value={formatCount(summary.chatTrackedCount)} detail="Joined chat on recently live streams" />
          <MetricCard label="Observed viewers" value={formatCount(summary.viewerCount)} detail={summary.viewerSampleCount === 0 ? "No recent viewer samples" : `Recent samples for ${summary.viewerSampleCount} of ${summary.recentCount} recently live streams`} />
        </section>
      ) : null}

      {streamsAvailable ? <div className="observation-notice">
        <div><strong>{summary.unconfirmedCount > 0 ? `${formatCount(summary.unconfirmedCount)} unconfirmed ${summary.unconfirmedCount === 1 ? "session" : "sessions"}` : "Snapshot view"}</strong>
          <p>{summary.unconfirmedCount > 0 ? "No recent live observation. These sessions may have ended." : "Refresh to load the latest observations."}</p>
          <span>Loaded <time dateTime={now.toISOString()}>{formatDateTime(now)}</time>{latestObservation == null ? "" : ` · Last seen live ${formatRelativeTime(latestObservation, now)}`}</span>
        </div><RetryButton label="Refresh data" pendingLabel="Refreshing…" />
      </div> : null}

      {featuredStreams.length === 0 ? null : (
        <section className="directory-section" aria-labelledby="top-live-heading">
          <div className="section-heading-row">
            <div className="section-heading">
              <h2 id="top-live-heading">Top observed streams</h2>
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

      <section className="panel" id="live-ranking">
        <div className="panel-header">
          <div className="panel-heading">
            <h2>{query === "" ? "Latest stream ranking" : "Search results"}</h2>
            <p>{query === "" ? "Viewer counts are periodic snapshots, not real-time telemetry." : `Matches for “${query}” · Ranks stay relative to all listed sessions.`}</p>
          </div>
          <StatusPill tone={streamsAvailable ? "accent" : "danger"}>{streamsAvailable ? query === "" ? `${streams.length} sessions` : `${matchingStreams.length} of ${streams.length} sessions` : "Unavailable"}</StatusPill>
        </div>

        {streamResponse == null ? (
          <EmptyState title="Live data is unavailable" description="The analytics service could not be reached. Try loading it again." action={<RetryButton />} />
        ) : streams.length === 0 ? (
          <EmptyState title="No streams currently listed" description="No Finnish stream is currently listed as live. Browse channels for past streams." />
        ) : rankedStreams.length === 0 ? (
          <EmptyState title="No matching live streams" description="Try another channel, stream title or category, or clear your search to see all live streams." action={<Link className="button button-secondary" href="/#live-ranking" prefetch={false}>Clear search</Link>} />
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
                {rankedStreams.map(({ stream, rank }) => {
                  const identity = stream.broadcasterDisplayName ?? stream.broadcasterLogin ?? stream.broadcasterId;
                  return (
                    <tr key={stream.streamId}>
                      <td className="rank-cell">{rank}</td>
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
            <span>Page {page} of {totalPages} · {formatCount(matchingStreams.length)} {query === "" ? "sessions" : "matches"}</span>
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
            <p>Continue exploring sessions after they leave the live ranking.</p>
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

      <p className="data-note">“Recently live” means observed within {recentObservationMinutes} minutes; this snapshot includes Finnish-language and Finnish-tagged streams. “Chat assigned” describes a joined chat connection; it does not guarantee complete capture or identify viewers. Missing and old viewer samples are excluded from the recent viewer total.</p>
    </>
  );
}

function LiveStreamCard({ stream, rank, now, priority }: { stream: LiveStreamSummary; rank: number; now: Date; priority: boolean }) {
  const identity = stream.broadcasterDisplayName ?? stream.broadcasterLogin ?? stream.broadcasterId;
  const thumbnailUrl = getSizedThumbnailUrl(stream.thumbnailUrl);
  const liveSeconds = Math.max(0, Math.floor((Date.parse(stream.lastSeenLiveAt) - Date.parse(stream.startedAt)) / 1000));

  return (
    <article className="live-card">
      <Link className="stream-preview" href={`/streams/${stream.streamId}`} aria-label={`Open ${identity} stream session`}>
        <StreamThumbnail src={thumbnailUrl} priority={priority} />
        <span className="stream-preview-topline">
          <StreamStatusBadge stream={stream} now={now} />
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
          <span className="number-cell">{formatDuration(liveSeconds)} observed · Seen live {formatRelativeTime(stream.lastSeenLiveAt, now)}</span>
          <span>{formatFinnishMatchReason(stream.finnishMatchReason)}</span>
          <ChatCoverage stream={stream} now={now} />
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
