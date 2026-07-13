import Link from "next/link";
import { getApiData, getAuthenticatedApiInit } from "../../api-client";
import { formatCount, formatDateTime, formatDuration } from "../../format";
import { Avatar, EmptyState, MetricCard, StatusPill } from "../../ui";

type Channel = {
  twitchUserId: string;
  login: string | null;
  displayName: string | null;
  description: string | null;
  profileImageUrl: string | null;
};

type StreamSession = {
  twitchStreamId: string;
  latestTitle: string | null;
  latestCategoryName: string | null;
  startedAt: string;
  endedAt: string | null;
};

type ViewerHistoryPoint = {
  twitchStreamId: string;
  observedAt: string;
  viewerCount: number | null;
  title: string | null;
  categoryName: string | null;
};

type ChannelActivity = {
  totals: {
    streamCount: number;
    liveSeconds: number;
    messageCount: number;
    viewerCountMax: number | null;
    viewerCountAvg: number | null;
  };
  daily: Array<{
    day: string;
    streamCount: number;
    liveSeconds: number;
    viewerCountMax: number | null;
    viewerCountAvg: number | null;
    messageCount: number;
  }>;
  recentBuckets: Array<{
    twitchStreamId: string;
    bucketStart: string;
    bucketMinutes: number;
    viewerCountAvg: number | null;
    messageCount: number;
    joinCount: number;
    partCount: number;
    activeChatterCount: number | null;
  }>;
};

export default async function ChannelPage({ params }: { params: Promise<{ login: string }> }) {
  const { login } = await params;
  const apiInit = await getAuthenticatedApiInit();
  const [channel, streamResponse, viewerHistoryResponse, activity] = await Promise.all([
    getApiData<Channel>(`/api/channels/${login}`, apiInit),
    getApiData<StreamSession[]>(`/api/channels/${login}/streams`, apiInit),
    getApiData<ViewerHistoryPoint[]>(`/api/channels/${login}/viewer-history`, apiInit),
    getApiData<ChannelActivity>(`/api/channels/${login}/activity`, apiInit)
  ]);
  const streams = streamResponse ?? [];
  const viewerHistory = viewerHistoryResponse ?? [];
  const name = channel?.displayName ?? channel?.login ?? login;
  const isLive = streams.some((stream) => stream.endedAt == null);

  return (
    <>
      <section className="page-title page-title-wide">
        <div className="breadcrumbs"><Link href="/">Live streams</Link><span>/</span><span>Channel</span></div>
        <div className="page-heading-row">
          <div className="identity-heading">
            <Avatar name={name} src={channel?.profileImageUrl} size="large" />
            <div>
              <span className="eyebrow">Channel analytics</span>
              <h1>{name}</h1>
            </div>
          </div>
          <div className="page-actions">
            {isLive ? <StatusPill tone="success">Live now</StatusPill> : <StatusPill>Offline</StatusPill>}
            <a className="button button-secondary" href={`https://www.twitch.tv/${channel?.login ?? login}`} target="_blank" rel="noreferrer">Open on Twitch ↗</a>
          </div>
        </div>
        <p>{channel?.description ?? "Stream history and aggregate activity appear here as the tracker observes this channel."}</p>
      </section>

      {channel == null ? (
        <div className="callout callout-warning">
          <div><strong>Channel profile unavailable</strong><p>The channel may be hidden, missing, or the API may be temporarily unavailable. Any accessible aggregate history is shown below.</p></div>
        </div>
      ) : null}

      <section className="stat-row" aria-label="Channel summary">
        <MetricCard label="Streams observed" value={formatCount(activity?.totals.streamCount ?? streams.length)} />
        <MetricCard label="Live time" value={activity == null ? "—" : formatDuration(activity.totals.liveSeconds)} />
        <MetricCard label="Peak viewers" value={formatCount(activity?.totals.viewerCountMax)} detail={activity?.totals.viewerCountAvg == null ? "No average yet" : `${formatCount(activity.totals.viewerCountAvg)} average viewers`} />
        <MetricCard label="Messages captured" value={formatCount(activity?.totals.messageCount)} detail="Only while chat tracking was active" />
      </section>

      <section className="panel">
        <div className="panel-header"><div className="panel-heading"><h2>Stream history</h2><p>Most recent sessions first</p></div><StatusPill>{streams.length} sessions</StatusPill></div>
        {streamResponse == null ? (
          <EmptyState title="Stream history unavailable" description="The API did not return stream history for this channel." />
        ) : streams.length === 0 ? (
          <EmptyState title="No sessions observed" description="No stream session has been associated with this channel yet." />
        ) : (
          <div className="table-scroll" role="region" aria-label="Channel stream history" tabIndex={0}>
            <table className="table">
              <thead><tr><th scope="col">Stream</th><th scope="col">Category</th><th scope="col">Started</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {streams.map((stream) => (
                  <tr key={stream.twitchStreamId}>
                    <td className="message-cell"><Link href={`/streams/${stream.twitchStreamId}`}><strong>{stream.latestTitle ?? "Untitled stream"}</strong></Link></td>
                    <td>{stream.latestCategoryName ?? <span className="muted">Unknown</span>}</td>
                    <td className="time-cell">{formatDateTime(stream.startedAt)}</td>
                    <td>{stream.endedAt == null ? <StatusPill tone="success">Live</StatusPill> : <StatusPill>Ended</StatusPill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header"><div className="panel-heading"><h2>Daily activity</h2><p>Fourteen latest aggregate days</p></div></div>
        {activity == null || activity.daily.length === 0 ? (
          <EmptyState title="No daily rollups" description="Daily channel activity has not been aggregated yet." />
        ) : (
          <div className="table-scroll" role="region" aria-label="Daily channel activity" tabIndex={0}>
            <table className="table">
              <thead><tr><th scope="col">Day</th><th scope="col">Streams</th><th scope="col">Live time</th><th scope="col">Peak viewers</th><th scope="col">Avg viewers</th><th scope="col">Messages</th></tr></thead>
              <tbody>
                {activity.daily.slice(0, 14).map((day) => (
                  <tr key={day.day}>
                    <td className="time-cell">{day.day}</td><td className="number-cell">{formatCount(day.streamCount)}</td><td className="number-cell">{formatDuration(day.liveSeconds)}</td><td className="number-cell">{formatCount(day.viewerCountMax)}</td><td className="number-cell">{formatCount(day.viewerCountAvg)}</td><td className="number-cell">{formatCount(day.messageCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header"><div className="panel-heading"><h2>Viewer snapshots</h2><p>Recent REST observations across sessions</p></div><StatusPill>{viewerHistory.length} loaded</StatusPill></div>
        {viewerHistoryResponse == null || viewerHistory.length === 0 ? (
          <EmptyState title="No viewer snapshots" description="Viewer snapshots have not been stored for this channel yet." />
        ) : (
          <div className="table-scroll" role="region" aria-label="Channel viewer history" tabIndex={0}>
            <table className="table">
              <thead><tr><th scope="col">Observed</th><th scope="col">Viewers</th><th scope="col">Stream</th><th scope="col">Category</th></tr></thead>
              <tbody>
                {viewerHistory.slice(0, 25).map((point) => (
                  <tr key={`${point.twitchStreamId}-${point.observedAt}`}>
                    <td className="time-cell">{formatDateTime(point.observedAt)}</td><td className="number-cell">{formatCount(point.viewerCount)}</td><td className="message-cell"><Link href={`/streams/${point.twitchStreamId}`}>{point.title ?? point.twitchStreamId}</Link></td><td>{point.categoryName ?? <span className="muted">Unknown</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header"><div className="panel-heading"><h2>Recent chat activity</h2><p>Coverage buckets are not exact viewership</p></div></div>
        {activity == null || activity.recentBuckets.length === 0 ? (
          <EmptyState title="No chat buckets" description="Aggregate chat activity has not been produced for this channel yet." />
        ) : (
          <div className="table-scroll" role="region" aria-label="Recent channel chat activity" tabIndex={0}>
            <table className="table">
              <thead><tr><th scope="col">Bucket</th><th scope="col">Stream</th><th scope="col">Messages</th><th scope="col">Active chatters</th><th scope="col">Joins</th><th scope="col">Parts</th></tr></thead>
              <tbody>
                {activity.recentBuckets.slice(0, 25).map((bucket) => (
                  <tr key={`${bucket.twitchStreamId}-${bucket.bucketStart}`}>
                    <td className="time-cell">{formatDateTime(bucket.bucketStart)}</td><td><Link href={`/streams/${bucket.twitchStreamId}`}>Open session</Link></td><td className="number-cell">{formatCount(bucket.messageCount)}</td><td className="number-cell">{formatCount(bucket.activeChatterCount)}</td><td className="number-cell">{formatCount(bucket.joinCount)}</td><td className="number-cell">{formatCount(bucket.partCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="data-note">Viewer counts come from periodic Twitch REST snapshots. Chat messages and presence signals are available only during active chat coverage.</p>
    </>
  );
}
