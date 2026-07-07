import Link from "next/link";
import { getApiData } from "../../api-client";

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
  const channel = await getApiData<Channel>(`/api/channels/${login}`);
  const streams = (await getApiData<StreamSession[]>(`/api/channels/${login}/streams`)) ?? [];
  const viewerHistory = (await getApiData<ViewerHistoryPoint[]>(`/api/channels/${login}/viewer-history`)) ?? [];
  const activity = await getApiData<ChannelActivity>(`/api/channels/${login}/activity`);

  return (
    <>
      <section className="page-title">
        <h1>{channel?.displayName ?? login}</h1>
        <p>{channel?.description ?? "Channel analytics will appear as streams are ingested."}</p>
      </section>

      <section className="stat-row">
        <div className="stat">
          <span className="muted">Streams</span>
          <strong>{activity?.totals.streamCount ?? streams.length}</strong>
        </div>
        <div className="stat">
          <span className="muted">Live Time</span>
          <strong>{formatDuration(activity?.totals.liveSeconds ?? 0)}</strong>
        </div>
        <div className="stat">
          <span className="muted">Peak Viewers</span>
          <strong>{activity?.totals.viewerCountMax ?? "No data"}</strong>
        </div>
        <div className="stat">
          <span className="muted">Messages</span>
          <strong>{activity?.totals.messageCount ?? 0}</strong>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Daily Activity</h2>
        </div>
        {activity == null || activity.daily.length === 0 ? (
          <p className="muted padded">No daily activity has been aggregated for this channel yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Streams</th>
                <th>Live Time</th>
                <th>Peak Viewers</th>
                <th>Avg Viewers</th>
                <th>Messages</th>
              </tr>
            </thead>
            <tbody>
              {activity.daily.slice(0, 14).map((day) => (
                <tr key={day.day}>
                  <td>{day.day}</td>
                  <td>{day.streamCount}</td>
                  <td>{formatDuration(day.liveSeconds)}</td>
                  <td>{day.viewerCountMax ?? "-"}</td>
                  <td>{day.viewerCountAvg ?? "-"}</td>
                  <td>{day.messageCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Viewer History</h2>
        </div>
        {viewerHistory.length === 0 ? (
          <p className="muted padded">No viewer snapshots have been stored for this channel yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Observed</th>
                <th>Viewers</th>
                <th>Stream</th>
                <th>Category</th>
              </tr>
            </thead>
            <tbody>
              {viewerHistory.slice(0, 25).map((point) => (
                <tr key={`${point.twitchStreamId}-${point.observedAt}`}>
                  <td>{new Date(point.observedAt).toLocaleString()}</td>
                  <td>{point.viewerCount ?? "-"}</td>
                  <td>
                    <Link href={`/streams/${point.twitchStreamId}`}>{point.title ?? point.twitchStreamId}</Link>
                  </td>
                  <td>{point.categoryName ?? "Unknown"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Recent Chat Buckets</h2>
        </div>
        {activity == null || activity.recentBuckets.length === 0 ? (
          <p className="muted padded">No chat activity buckets have been aggregated for this channel yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Bucket</th>
                <th>Messages</th>
                <th>Active Chatters</th>
                <th>Joins</th>
                <th>Parts</th>
              </tr>
            </thead>
            <tbody>
              {activity.recentBuckets.slice(0, 25).map((bucket) => (
                <tr key={`${bucket.twitchStreamId}-${bucket.bucketStart}`}>
                  <td>{new Date(bucket.bucketStart).toLocaleString()}</td>
                  <td>{bucket.messageCount}</td>
                  <td>{bucket.activeChatterCount ?? "-"}</td>
                  <td>{bucket.joinCount}</td>
                  <td>{bucket.partCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Stream History</h2>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Stream</th>
              <th>Title</th>
              <th>Category</th>
              <th>Started</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {streams.map((stream) => (
              <tr key={stream.twitchStreamId}>
                <td>
                  <Link href={`/streams/${stream.twitchStreamId}`}>{stream.twitchStreamId}</Link>
                </td>
                <td>{stream.latestTitle ?? "Untitled"}</td>
                <td>{stream.latestCategoryName ?? "Unknown"}</td>
                <td>{new Date(stream.startedAt).toLocaleString()}</td>
                <td>{stream.endedAt == null ? "Live" : "Ended"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function formatDuration(seconds: number) {
  if (seconds <= 0) {
    return "0h";
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}
