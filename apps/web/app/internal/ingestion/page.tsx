import type { InternalIngestionStatus } from "@twitch-tracker/shared";
import { cookies } from "next/headers";
import { getApiData } from "../../api-client";

export default async function IngestionPage() {
  const cookieHeader = cookies().toString();
  const apiInit: RequestInit = cookieHeader === ""
    ? { cache: "no-store" }
    : { cache: "no-store", headers: { Cookie: cookieHeader } };
  const status = await getApiData<InternalIngestionStatus>("/api/internal/ingestion", apiInit);

  return (
    <>
      <section className="page-title">
        <h1>Ingestion</h1>
        <p>Worker heartbeats, chat assignments, and recent ingestion runs.</p>
      </section>

      <section className="stat-row">
        <div className="stat">
          <span className="muted">Mode</span>
          <strong>{status?.mode ?? "blocked"}</strong>
        </div>
        <div className="stat">
          <span className="muted">Active assignments</span>
          <strong>{status?.activeAssignments ?? 0}</strong>
        </div>
        <div className="stat">
          <span className="muted">EventSub states</span>
          <strong>{status?.eventSubSubscriptions.reduce((total, item) => total + item.count, 0) ?? 0}</strong>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Worker Heartbeats</h2>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Worker</th>
              <th>Loop</th>
              <th>Status</th>
              <th>Last heartbeat</th>
            </tr>
          </thead>
          <tbody>
            {(status?.workerHeartbeats ?? []).map((heartbeat) => (
              <tr key={`${heartbeat.workerName}:${heartbeat.loopName}`}>
                <td>{heartbeat.workerName}</td>
                <td>{heartbeat.loopName}</td>
                <td>{heartbeat.status}</td>
                <td>{new Date(heartbeat.lastHeartbeatAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>EventSub Subscriptions</h2>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {(status?.eventSubSubscriptions ?? []).map((subscription) => (
              <tr key={subscription.status}>
                <td>{subscription.status}</td>
                <td>{subscription.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
