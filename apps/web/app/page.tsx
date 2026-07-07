import type { LiveStreamSummary } from "@twitch-tracker/shared";
import Link from "next/link";
import { getApiData } from "./api-client";

export default async function HomePage() {
  const streams = (await getApiData<LiveStreamSummary[]>("/api/streams/live")) ?? [];
  const totalViewers = streams.reduce((sum, stream) => sum + (stream.viewerCount ?? 0), 0);

  return (
    <>
      <section className="page-title">
        <h1>Live Finnish Streams</h1>
        <p>Current Finnish-language Twitch streams discovered by the tracker.</p>
      </section>

      <section className="stat-row" aria-label="Live stream summary">
        <div className="stat">
          <span className="muted">Live streams</span>
          <strong>{streams.length}</strong>
        </div>
        <div className="stat">
          <span className="muted">Chat-tracked</span>
          <strong>{streams.filter((stream) => stream.isChatTracked).length}</strong>
        </div>
        <div className="stat">
          <span className="muted">Current viewers</span>
          <strong>{totalViewers}</strong>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Ranking</h2>
          <span className="badge">language=fi</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Title</th>
              <th>Category</th>
              <th>Viewers</th>
              <th>Started</th>
              <th>Chat</th>
            </tr>
          </thead>
          <tbody>
            {streams.map((stream) => (
              <tr key={stream.streamId}>
                <td>
                  {stream.broadcasterLogin == null ? (
                    stream.broadcasterId
                  ) : (
                    <Link href={`/channels/${stream.broadcasterLogin}`}>{stream.broadcasterDisplayName ?? stream.broadcasterLogin}</Link>
                  )}
                </td>
                <td>{stream.title ?? "Untitled"}</td>
                <td>{stream.categoryName ?? "Unknown"}</td>
                <td>{stream.viewerCount ?? "-"}</td>
                <td>{new Date(stream.startedAt).toLocaleString()}</td>
                <td>{chatStatusLabel(stream)}</td>
              </tr>
            ))}
            {streams.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  No live streams have been stored yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </>
  );
}

const chatStatusLabel = (stream: LiveStreamSummary) => {
  if (stream.chatAssignmentStatus == null) {
    return "Not assigned";
  }

  return stream.chatAssignmentStatus === "joined" ? "Tracked" : stream.chatAssignmentStatus;
};
