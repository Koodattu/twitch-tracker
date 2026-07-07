import { cookies } from "next/headers";
import { getApiData } from "../../api-client";
import { StreamActivityChart } from "./activity-chart";

type StreamSession = {
  twitchStreamId: string;
  broadcasterUserId: string;
  latestTitle: string | null;
  latestCategoryName: string | null;
  language: string | null;
  startedAt: string;
  endedAt: string | null;
  firstSeenAt: string;
  lastSeenLiveAt: string;
};

type StreamActivity = {
  totals: {
    viewerCountMax: number | null;
    viewerCountAvg: number | null;
    messageCount: number;
    joinCount: number;
    partCount: number;
    activeChatterCountMax: number | null;
  };
  snapshots: Array<{
    observedAt: string;
    viewerCount: number | null;
    title: string | null;
    categoryName: string | null;
  }>;
  buckets: Array<{
    bucketStart: string;
    bucketMinutes: number;
    viewerCountAvg: number | null;
    messageCount: number;
    joinCount: number;
    partCount: number;
    activeChatterCount: number | null;
    eventCounts: Record<string, number>;
  }>;
  events: Array<{
    id: string;
    eventType: string;
    actorUserId: string | null;
    occurredAt: string;
    source: string;
    sourceEventId: string | null;
  }>;
  raids: Array<{
    id: string;
    sourceBroadcasterUserId: string | null;
    targetBroadcasterUserId: string | null;
    viewerCount: number | null;
    occurredAt: string;
  }>;
};

type PrivateStreamRaw = {
  messages: Array<{
    messageId: string;
    chatterUserId: string | null;
    chatterLogin: string | null;
    chatterDisplayName: string | null;
    sentAt: string | null;
    receivedAt: string;
    rawText: string | null;
    source: string;
    messageType: string;
  }>;
  membershipEvents: Array<{
    id: string;
    eventType: string;
    source: string;
    confidence: number;
    chatterUserId: string | null;
    chatterLogin: string | null;
    eventAt: string | null;
    receivedAt: string;
  }>;
  presenceSnapshots: Array<{
    id: string;
    source: string;
    confidence: number;
    sampledAt: string;
    chatterCount: number;
    pageCount: number;
    requestStatus: string;
    latestError: string | null;
  }>;
};

export default async function StreamPage({ params }: { params: Promise<{ streamId: string }> }) {
  const { streamId } = await params;
  const cookieHeader = cookies().toString();
  const privateApiInit: RequestInit = cookieHeader === ""
    ? { cache: "no-store" }
    : { cache: "no-store", headers: { Cookie: cookieHeader } };
  const stream = await getApiData<StreamSession>(`/api/streams/${streamId}`);
  const activity = await getApiData<StreamActivity>(`/api/streams/${streamId}/activity`);
  const raw = await getApiData<PrivateStreamRaw>(`/api/private/streams/${streamId}/raw`, privateApiInit);
  const chartPoints = (activity?.buckets ?? [])
    .slice()
    .reverse()
    .map((bucket) => ({
      time: new Date(bucket.bucketStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      viewers: bucket.viewerCountAvg,
      messages: bucket.messageCount,
      activeChatters: bucket.activeChatterCount
    }));

  return (
    <>
      <section className="page-title">
        <h1>{stream?.latestTitle ?? streamId}</h1>
        <p>Single stream session timeline and activity surface.</p>
      </section>

      <section className="stat-row">
        <div className="stat">
          <span className="muted">Language</span>
          <strong>{stream?.language ?? "Unknown"}</strong>
        </div>
        <div className="stat">
          <span className="muted">Status</span>
          <strong>{stream == null ? "Missing" : stream.endedAt == null ? "Live" : "Ended"}</strong>
        </div>
        <div className="stat">
          <span className="muted">Peak Viewers</span>
          <strong>{activity?.totals.viewerCountMax ?? "No data"}</strong>
        </div>
        <div className="stat">
          <span className="muted">Messages</span>
          <strong>{activity?.totals.messageCount ?? 0}</strong>
        </div>
        <div className="stat">
          <span className="muted">Active Chatters</span>
          <strong>{activity?.totals.activeChatterCountMax ?? "No data"}</strong>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Timeline</h2>
        </div>
        <table className="table">
          <tbody>
            <tr>
              <th>Started</th>
              <td>{stream == null ? "-" : new Date(stream.startedAt).toLocaleString()}</td>
            </tr>
            <tr>
              <th>First seen</th>
              <td>{stream == null ? "-" : new Date(stream.firstSeenAt).toLocaleString()}</td>
            </tr>
            <tr>
              <th>Last seen live</th>
              <td>{stream == null ? "-" : new Date(stream.lastSeenLiveAt).toLocaleString()}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Viewer Snapshots</h2>
        </div>
        {activity == null || activity.snapshots.length === 0 ? (
          <p className="muted padded">No viewer snapshots have been stored for this stream yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Observed</th>
                <th>Viewers</th>
                <th>Category</th>
                <th>Title</th>
              </tr>
            </thead>
            <tbody>
              {activity.snapshots.slice(0, 25).map((snapshot) => (
                <tr key={snapshot.observedAt}>
                  <td>{new Date(snapshot.observedAt).toLocaleString()}</td>
                  <td>{snapshot.viewerCount ?? "-"}</td>
                  <td>{snapshot.categoryName ?? "Unknown"}</td>
                  <td>{snapshot.title ?? "Untitled"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Activity Chart</h2>
        </div>
        <StreamActivityChart points={chartPoints} />
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Activity Buckets</h2>
        </div>
        {activity == null || activity.buckets.length === 0 ? (
          <p className="muted padded">No activity buckets have been aggregated for this stream yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Bucket</th>
                <th>Viewers</th>
                <th>Messages</th>
                <th>Active Chatters</th>
                <th>JOIN/PART</th>
                <th>Events</th>
              </tr>
            </thead>
            <tbody>
              {activity.buckets.slice(0, 30).map((bucket) => (
                <tr key={bucket.bucketStart}>
                  <td>{new Date(bucket.bucketStart).toLocaleString()}</td>
                  <td>{bucket.viewerCountAvg ?? "-"}</td>
                  <td>{bucket.messageCount}</td>
                  <td>{bucket.activeChatterCount ?? "-"}</td>
                  <td>{bucket.joinCount}/{bucket.partCount}</td>
                  <td>{formatEventCounts(bucket.eventCounts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Chat Messages</h2>
          <span className="badge">{raw?.messages.length ?? 0} shown</span>
        </div>
        {raw == null ? (
          <p className="muted padded">Message detail is not available for this session.</p>
        ) : raw.messages.length === 0 ? (
          <p className="muted padded">No messages have been captured for this stream yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Chatter</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {raw.messages.map((message) => (
                <tr key={message.messageId}>
                  <td>{new Date(message.sentAt ?? message.receivedAt).toLocaleString()}</td>
                  <td>
                    {message.chatterLogin == null ? (
                      <span className="muted">unknown</span>
                    ) : (
                      <a href={`/chatters/${message.chatterLogin}`}>{message.chatterDisplayName ?? message.chatterLogin}</a>
                    )}
                  </td>
                  <td className="message-cell">{message.rawText ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Presence Reconciliation</h2>
          <span className="badge">{raw?.presenceSnapshots.length ?? 0} snapshots</span>
        </div>
        {raw == null || raw.presenceSnapshots.length === 0 ? (
          <p className="muted padded">No Get Chatters snapshots have been stored for this stream.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Sampled</th>
                <th>Chatters</th>
                <th>Source</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {raw.presenceSnapshots.slice(0, 20).map((snapshot) => (
                <tr key={snapshot.id}>
                  <td>{new Date(snapshot.sampledAt).toLocaleString()}</td>
                  <td>{snapshot.chatterCount}</td>
                  <td>{snapshot.source} / {snapshot.confidence}%</td>
                  <td>{snapshot.requestStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Channel Events</h2>
          <span className="badge">{activity?.raids.length ?? 0} raids</span>
        </div>
        {activity == null || (activity.events.length === 0 && activity.raids.length === 0) ? (
          <p className="muted padded">No channel events have been stored for this stream yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Source</th>
                <th>Actor</th>
              </tr>
            </thead>
            <tbody>
              {activity.events.slice(0, 50).map((event) => (
                <tr key={event.id}>
                  <td>{new Date(event.occurredAt).toLocaleString()}</td>
                  <td>{event.eventType}</td>
                  <td>{event.source}</td>
                  <td>{event.actorUserId ?? "-"}</td>
                </tr>
              ))}
              {activity.raids.slice(0, 25).map((raid) => (
                <tr key={raid.id}>
                  <td>{new Date(raid.occurredAt).toLocaleString()}</td>
                  <td>raid</td>
                  <td>{raid.viewerCount == null ? "EventSub" : `${raid.viewerCount} viewers`}</td>
                  <td>{raid.sourceBroadcasterUserId ?? raid.targetBroadcasterUserId ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function formatEventCounts(eventCounts: Record<string, number>) {
  const entries = Object.entries(eventCounts);
  if (entries.length === 0) {
    return "-";
  }

  return entries.map(([eventType, count]) => `${eventType}: ${count}`).join(", ");
}
