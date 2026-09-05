import Link from "next/link";
import type { Metadata } from "next";
import type { StreamOverview } from "@twitch-tracker/shared";
import { getApiData, getPublicApiInit } from "../../api-client";
import { formatCount } from "../../format";
import { EmptyState, MetricCard } from "../../ui";
import { StreamActivityChart } from "./activity-chart";
import { EventTimeline } from "./detail-ui";

export const metadata: Metadata = { title: "Stream overview" };

export default async function StreamPage({ params }: { params: Promise<{ streamId: string }> }) {
  const { streamId } = await params;
  const activity = await getApiData<StreamOverview>(`/api/streams/${encodeURIComponent(streamId)}/overview`, await getPublicApiInit());
  if (activity == null) return <section className="panel"><EmptyState title="Activity unavailable" description="Stream activity could not be loaded right now. Please try again later." /></section>;
  return <>
    <section className="stat-row stream-summary" aria-label="Stream summary">
      <MetricCard label="Average viewers" value={formatCount(activity.totals.viewerCountAvg)} detail="Across observed activity intervals" />
      <MetricCard label="Peak viewers" value={formatCount(activity.totals.viewerCountMax)} />
      <MetricCard label="Messages captured" value={formatCount(activity.totals.messageCount)} />
      <MetricCard label="Peak active chatters" value={formatCount(activity.totals.activeChatterCountMax)} detail="Distinct speakers in one activity interval" />
    </section>
    <StreamActivityChart activity={activity} />
    <section className="panel">
      <div className="panel-header"><div className="panel-heading"><h2>Recent events</h2><p>Latest channel events and raids</p></div><Link className="button button-secondary button-compact" href={`/streams/${encodeURIComponent(streamId)}/events`} prefetch={false}>View all events</Link></div>
      <EventTimeline events={activity.events} />
    </section>
    <p className="data-note">Chat activity includes captured messages only. Missing observations do not mean the stream or chat was inactive.</p>
  </>;
}
