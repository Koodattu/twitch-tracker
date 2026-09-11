import Link from "next/link";
import type { ChannelOverview } from "@twitch-tracker/shared";
import { getApiData, getPublicApiInit } from "../../api-client";
import { formatCount, formatDateTime, formatDuration } from "../../format";
import { DetailUnavailable } from "../../detail-ui";
import { EmptyState, MetricCard, StatusPill } from "../../ui";
import { ViewerTrendChart } from "./viewer-trend-chart";
import { CategoryArt } from "./category-art";

export default async function ChannelPage({ params }: { params: Promise<{ login: string }> }) {
  const { login } = await params;
  const overview = await getApiData<ChannelOverview>(`/api/channels/${encodeURIComponent(login)}/overview`, await getPublicApiInit());
  if (overview == null) return <section className="panel"><DetailUnavailable /></section>;
  const { totals, liveSession, topCategories } = overview;
  const streamPath = `/channels/${encodeURIComponent(login)}/streams`;
  const chatDays = overview.daily.filter((day) => day.messageCount > 0);
  const busiestChat = [...chatDays].sort((a, b) => b.messageCount - a.messageCount)[0];
  const maxMessages = busiestChat?.messageCount ?? 1;
  const categoryShare = overview.categorySeconds === 0 || topCategories[0] == null ? 0 : Math.round(topCategories[0].liveSeconds / overview.categorySeconds * 100);
  return <div className="channel-overview">
    {liveSession == null ? null : <div className="channel-live">
      <div className="channel-live-copy"><StatusPill tone="success">Live now</StatusPill><strong>{liveSession.latestTitle ?? "This channel is live"}</strong><span className="muted">{liveSession.latestCategoryName}</span></div>
      <Link className="button button-secondary button-compact" href={`/streams/${encodeURIComponent(liveSession.twitchStreamId)}`} prefetch={false}>View live stream ↗</Link>
    </div>}
    <div className="channel-period"><h2>Last 30 days</h2><span>{overview.fromDay} – {overview.toDay} · UTC</span></div>
    <section className="stat-row stream-summary channel-metrics" aria-label="Channel summary for the last 30 days">
      <MetricCard label="Average viewers" value={formatCount(totals?.viewerCountAvg)} detail="During observed stream time" />
      <MetricCard label="Peak viewers" value={formatCount(totals?.viewerCountMax)} detail="Highest observed audience" />
      <MetricCard label="Hours streamed" value={totals == null ? "—" : `${formatCount(Math.round(totals.liveSeconds / 3600 * 10) / 10)}h`} detail="Stream time within this period" />
      <MetricCard label="Streams" value={formatCount(totals?.streamCount)} detail="Started in this period" />
    </section>
    <ViewerTrendChart overview={overview} />
    <div className="channel-discovery-grid">
      <section className="panel channel-categories">
        <div className="panel-header"><div className="panel-heading"><h2>Top games & categories</h2><p>By observed airtime · Last 30 days</p></div>{overview.categoryCount > 0 ? <span className="badge">{formatCount(overview.categoryCount)} {overview.categoryCount === 1 ? "category" : "categories"}</span> : null}</div>
        {topCategories.length === 0 ? <EmptyState title="No category history yet" description="Games and categories will appear as more stream activity is observed." /> : <>
          <div className="channel-category-grid">{topCategories.map((category, index) => {
            const share = Math.round(category.liveSeconds / overview.categorySeconds * 100);
            return <article className="channel-category" key={category.id}>
              <div className="channel-category-cover"><CategoryArt id={category.id} /><span className="channel-category-rank">{index + 1}</span></div>
              <h3>{category.name}</h3>
              <div className="channel-category-time"><strong>{formatDuration(category.liveSeconds)}</strong><span>{share}%</span></div>
              <meter className="channel-share" min={0} max={100} value={share} aria-label={`${category.name}: ${share}% of classified airtime`} />
              <p>{formatCount(category.viewerCountAvg)} <span>avg viewers</span></p>
            </article>;
          })}</div>
          <div className="channel-category-summary"><span><strong>{topCategories[0]!.name}</strong> made up {categoryShare}% of classified airtime.</span><span className="muted">{formatDuration(overview.categorySeconds)} classified</span></div>
        </>}
      </section>
      <section className="panel channel-chat-summary">
        <div className="panel-header"><div className="panel-heading"><h2>Chat activity</h2><p>From captured chat · Last 30 days</p></div></div>
        {chatDays.length === 0 ? <EmptyState title="No chat activity recorded" description="Chat isn’t captured for every stream. This doesn’t mean nobody was chatting." /> : <div className="channel-chat-body">
          <div className="channel-chat-total"><strong>{formatCount(totals?.messageCount)}</strong><span>messages captured</span></div>
          <div className="channel-chat-bars" role="img" aria-label={`Messages were captured on ${chatDays.length} days in this period.`}>{Array.from({ length: 30 }, (_, index) => {
            const day = new Date(Date.parse(overview.fromDay) + index * 86_400_000).toISOString().slice(0, 10);
            const messages = overview.daily.find((record) => record.day === day)?.messageCount ?? 0;
            return <span key={day} style={{ height: `${Math.max(4, messages / maxMessages * 100)}%` }} data-empty={messages === 0} />;
          })}</div>
          <div className="channel-chat-fact"><span>Days with captured chat</span><strong>{formatCount(chatDays.length)}</strong></div>
          {busiestChat == null ? null : <div className="channel-chat-fact"><span>Busiest day<small>{busiestChat.day}</small></span><strong>{formatCount(busiestChat.messageCount)}<small>messages</small></strong></div>}
          <p className="channel-caption">Captured activity can include Shared Chat. It doesn’t measure unique viewers or time spent watching.</p>
        </div>}
      </section>
    </div>
    <section className="panel channel-recent">
      <div className="panel-header"><div className="panel-heading"><h2>Recent streams</h2><p>The latest from this channel · Across all dates</p></div><Link className="text-link" href={streamPath} prefetch={false}>All streams →</Link></div>
      {overview.recentSessions.length === 0 ? <EmptyState title="No streams recorded yet" description="Recent streams will appear here when this channel goes live." /> : <div className="channel-recent-grid">{overview.recentSessions.slice(0, 3).map((session) => <Link className="channel-recent-card" key={session.twitchStreamId} href={`/streams/${encodeURIComponent(session.twitchStreamId)}`} prefetch={false}>
        <CategoryArt id={session.latestCategoryId} />
        <div><span className="channel-recent-date">{session.endedAt == null ? <span className="channel-live-label">Live now</span> : <time dateTime={session.startedAt}>{formatDateTime(session.startedAt)}</time>}</span>
          <h3>{session.latestTitle ?? "Untitled stream"}</h3><p>{session.latestCategoryName ?? "Category unavailable"}</p>
          <span className="channel-caption">{formatDuration(Math.max(0, (Date.parse(session.endedAt ?? session.lastSeenLiveAt) - Date.parse(session.startedAt)) / 1000))}{session.endedAt == null ? " observed" : " streamed"}</span>
        </div>
      </Link>)}</div>}
    </section>
    <details className="channel-methodology"><summary>About these numbers</summary><p>Stream time is split across UTC days and limited to this period. Audience averages are weighted by observed time; observations are carried forward for up to {formatDuration(overview.observationGapSeconds)}, with longer gaps left uncounted. Category shares use only airtime with a known category. Missing data is shown as a dash, not zero.</p><p>Audience observed for {formatDuration(overview.viewerSeconds)}. Categories observed for {formatDuration(overview.categorySeconds)}. Chat totals can take a few minutes to update and only include captured activity.</p></details>
  </div>;
}
