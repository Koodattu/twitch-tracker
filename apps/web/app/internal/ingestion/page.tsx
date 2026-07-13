import type { InternalIngestionStatus } from "@twitch-tracker/shared";
import Link from "next/link";
import { getApiData, getAuthenticatedApiInit } from "../../api-client";
import { formatCount, formatDateTime, formatStatus } from "../../format";
import { EmptyState, MetricCard, StatusPill } from "../../ui";

export default async function IngestionPage() {
  const apiInit = await getAuthenticatedApiInit();
  const status = await getApiData<InternalIngestionStatus>("/api/internal/ingestion", apiInit);

  return (
    <>
      <section className="page-title page-title-wide">
        <span className="eyebrow">Admin · Operations</span>
        <div className="page-heading-row"><div><h1>Ingestion health</h1><p>Worker freshness, assignment load, recent runs, and EventSub state in one operational view.</p></div><StatusPill tone={status == null ? "danger" : "accent"}>{status == null ? "Unavailable" : formatStatus(status.mode)}</StatusPill></div>
      </section>

      {status == null ? (
        <section className="panel"><EmptyState title="Ingestion status unavailable" description="Log in with an administrator account, or check the API and worker services." action={<Link className="button" href="/me">Go to login</Link>} /></section>
      ) : (
        <>
          <section className="stat-row" aria-label="Ingestion summary">
            <MetricCard label="Deployment mode" value={formatStatus(status.mode)} />
            <MetricCard label="Active assignments" value={formatCount(status.activeAssignments)} />
            <MetricCard label="Worker loops" value={formatCount(status.workerHeartbeats.length)} detail="Latest heartbeat per recorded loop" />
            <MetricCard label="EventSub subscriptions" value={formatCount(status.eventSubSubscriptions.reduce((total, item) => total + item.count, 0))} />
          </section>

          <section className="panel">
            <div className="panel-header"><div className="panel-heading"><h2>Worker heartbeats</h2><p>Latest known loop state</p></div><StatusPill>{status.workerHeartbeats.length} loops</StatusPill></div>
            {status.workerHeartbeats.length === 0 ? <EmptyState title="No worker heartbeats" description="No loop heartbeat has been recorded." /> : (
              <div className="table-scroll" role="region" aria-label="Worker heartbeats" tabIndex={0}><table className="table table-compact"><thead><tr><th scope="col">Worker</th><th scope="col">Loop</th><th scope="col">Status</th><th scope="col">Last heartbeat</th></tr></thead><tbody>
                {status.workerHeartbeats.map((heartbeat) => <tr key={`${heartbeat.workerName}:${heartbeat.loopName}`}><td><strong>{heartbeat.workerName}</strong></td><td>{formatStatus(heartbeat.loopName)}</td><td><StatusPill tone={heartbeat.status === "healthy" || heartbeat.status === "running" ? "success" : "warning"}>{formatStatus(heartbeat.status)}</StatusPill></td><td className="time-cell">{formatDateTime(heartbeat.lastHeartbeatAt)}</td></tr>)}
              </tbody></table></div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header"><div className="panel-heading"><h2>Recent ingestion runs</h2><p>Newest scheduled work first</p></div><StatusPill>{status.recentRuns.length} loaded</StatusPill></div>
            {status.recentRuns.length === 0 ? <EmptyState title="No ingestion runs" description="No recurring worker run has been stored." /> : (
              <div className="table-scroll" role="region" aria-label="Recent ingestion runs" tabIndex={0}><table className="table table-compact"><thead><tr><th scope="col">Job</th><th scope="col">Status</th><th scope="col">Started</th><th scope="col">Finished</th></tr></thead><tbody>
                {status.recentRuns.map((run, index) => <tr key={`${run.jobType}-${run.startedAt}-${index}`}><td><strong>{formatStatus(run.jobType)}</strong></td><td><StatusPill tone={run.status === "succeeded" || run.status === "completed" ? "success" : run.status === "running" ? "accent" : "warning"}>{formatStatus(run.status)}</StatusPill></td><td className="time-cell">{formatDateTime(run.startedAt)}</td><td className="time-cell">{formatDateTime(run.finishedAt)}</td></tr>)}
              </tbody></table></div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header"><div className="panel-heading"><h2>EventSub subscriptions</h2><p>Counts grouped by current status</p></div></div>
            {status.eventSubSubscriptions.length === 0 ? <EmptyState title="No EventSub state" description="No subscription state has been recorded." /> : (
              <div className="table-scroll" role="region" aria-label="EventSub subscription states" tabIndex={0}><table className="table table-compact"><thead><tr><th scope="col">Status</th><th scope="col">Count</th></tr></thead><tbody>
                {status.eventSubSubscriptions.map((subscription) => <tr key={subscription.status}><td><StatusPill tone={subscription.status === "enabled" ? "success" : "neutral"}>{formatStatus(subscription.status)}</StatusPill></td><td className="number-cell">{formatCount(subscription.count)}</td></tr>)}
              </tbody></table></div>
            )}
          </section>
        </>
      )}
    </>
  );
}
