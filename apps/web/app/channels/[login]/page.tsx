import Link from "next/link";
import type { ChannelOverview } from "@twitch-tracker/shared";
import { getApiData, getPublicApiInit } from "../../api-client";
import { formatCount, formatDuration } from "../../format";
import { DetailUnavailable } from "../../detail-ui";
import { MetricCard, StatusPill } from "../../ui";
import { ViewerTrendChart } from "./viewer-trend-chart";
import { ChannelSessionList } from "./session-list";

export default async function ChannelPage({ params }: { params: Promise<{ login: string }> }) {
  const { login } = await params;
  const overview = await getApiData<ChannelOverview>(`/api/channels/${encodeURIComponent(login)}/overview`, await getPublicApiInit());
  if (overview == null) return <section className="panel"><DetailUnavailable /></section>;
  const { totals, liveSession } = overview;
  return <>
    {liveSession == null ? null : <div className="callout">
      <div><StatusPill tone="success">Live now</StatusPill><p>{liveSession.latestTitle ?? "This channel is live."}</p></div>
      <Link className="button" href={`/streams/${encodeURIComponent(liveSession.twitchStreamId)}`} prefetch={false}>Open live session</Link>
    </div>}
    <div className="section-heading-row"><h2>Last 30 days</h2><span className="muted">{overview.fromDay} – {overview.toDay} · UTC</span></div>
    <section className="stat-row stream-summary" aria-label="Channel summary for the last 30 days">
      <MetricCard label="Streams started" value={formatCount(totals?.streamCount)} />
      <MetricCard label="Stream time" value={totals == null ? "—" : formatDuration(totals.liveSeconds)} detail="Grouped by session start date" />
      <MetricCard label="Peak viewers" value={formatCount(totals?.viewerCountMax)} detail={totals?.viewerCountAvg == null ? "No daily viewer average yet" : `${formatCount(totals.viewerCountAvg)} average across observed days`} />
      <MetricCard label="Messages captured" value={formatCount(totals?.messageCount)} detail="Only where chat was captured" />
    </section>
    <ViewerTrendChart overview={overview} />
    <section className="panel">
      <div className="panel-header"><div className="panel-heading"><h2>Recent sessions</h2><p>Six most recent sessions across all dates</p></div><Link className="button button-secondary button-compact" href={`/channels/${encodeURIComponent(login)}/streams`} prefetch={false}>View all streams</Link></div>
      <ChannelSessionList sessions={overview.recentSessions} />
    </section>
    <p className="data-note">Recent activity may take a few minutes to appear. Stream time is grouped by the date each session started. Missing observations do not mean the channel was offline.</p>
  </>;
}
