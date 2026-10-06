import Link from "next/link";
import type { ChannelOverview } from "@twitch-tracker/shared";
import { getApiData, getPublicApiInit } from "../../api-client";
import { formatCount, formatDateTime, formatDuration, formatRelativeTime } from "../../format";
import { DetailUnavailable } from "../../detail-ui";
import { EmptyState, MetricCard } from "../../ui";
import { StreamStatusBadge } from "../../stream-status-badge";
import { channelStreamHref } from "../../channel-return";
import { ViewerTrendChart } from "./viewer-trend-chart";
import { CategoryArt } from "./category-art";
import { channelViewQuery, readChannelView, type ChannelSearch } from "./channel-view";
import { PeriodControls } from "./period-controls";

export default async function ChannelPage({ params, searchParams }: { params: Promise<{ login: string }>; searchParams: Promise<ChannelSearch> }) {
  const { login } = await params;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const view = readChannelView(await searchParams, today);
  const pathname = `/channels/${encodeURIComponent(login)}`;
  const toDay = view.end ?? today;
  const fromDay = new Date(Date.parse(toDay) - (view.days - 1) * 86_400_000).toISOString().slice(0, 10);
  const controls = <PeriodControls pathname={pathname} fromDay={fromDay} toDay={toDay} today={today} />;
  const overview = await getApiData<ChannelOverview>(`/api/channels/${encodeURIComponent(login)}/overview?${new URLSearchParams({ days: String(view.days), end: toDay })}`, { ...await getPublicApiInit(), cache: "no-store" });
  if (overview == null) return <div className="channel-overview">{controls}<section className="panel"><DetailUnavailable /></section></div>;
  const { totals, liveSession, topCategories } = overview;
  const returnTo = `${pathname}?${channelViewQuery(view)}`;
  const streamPath = `${pathname}/streams?${channelViewQuery({ ...view, day: undefined })}`;
  const chatDays = overview.daily.filter((day) => day.messageCount > 0);
  const busiestChat = [...chatDays].sort((a, b) => b.messageCount - a.messageCount)[0];
  const maxMessages = busiestChat?.messageCount ?? 1;
  const categoryShare = overview.categorySeconds === 0 || topCategories[0] == null ? 0 : Math.round(topCategories[0].liveSeconds / overview.categorySeconds * 100);
  return <div className="channel-overview">
    {view.invalid ? <p className="data-note" role="status">Some view options were invalid. Showing the valid period and selections below.</p> : null}
    {liveSession == null ? null : <div className="channel-live">
      <div className="channel-live-copy"><StreamStatusBadge stream={liveSession} now={now} /><strong>{liveSession.latestTitle ?? "Latest stream session"}</strong><span className="muted">{liveSession.latestCategoryName} · Seen live {formatRelativeTime(liveSession.lastSeenLiveAt, now)}</span></div>
      <Link className="button button-secondary button-compact" href={channelStreamHref(liveSession.twitchStreamId, returnTo)} prefetch={false}>View stream ↗</Link>
    </div>}
    {controls}
    <section className="stat-row stream-summary channel-metrics" aria-label={`Channel summary for ${overview.fromDay} to ${overview.toDay}`}>
      <MetricCard label="Average viewers" value={formatCount(totals?.viewerCountAvg)} detail="During observed stream time" />
      <MetricCard label="Peak viewers" value={formatCount(totals?.viewerCountMax)} detail="Highest observed audience" />
      <MetricCard label="Hours streamed" value={totals == null ? "—" : `${formatCount(Math.round(totals.liveSeconds / 3600 * 10) / 10)}h`} detail="Stream time within this period" />
      <MetricCard label="Streams" value={formatCount(totals?.streamCount)} detail="Started in this period" />
    </section>
    <ViewerTrendChart key={`${overview.fromDay}:${overview.toDay}`} overview={overview} login={login} />
    <div className="channel-discovery-grid">
      <section className="panel channel-categories">
        <div className="panel-header"><div className="panel-heading"><h2>Top games & categories</h2><p>By observed airtime · Selected {view.days} days</p></div>{overview.categoryCount > 0 ? <span className="badge">{formatCount(overview.categoryCount)} {overview.categoryCount === 1 ? "category" : "categories"}</span> : null}</div>
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
        <div className="panel-header"><div className="panel-heading"><h2>Chat activity</h2><p>From captured chat · Selected {view.days} days</p></div></div>
        {chatDays.length === 0 ? <EmptyState title="No chat activity recorded" description="Chat isn’t captured for every stream. This doesn’t mean nobody was chatting." /> : <div className="channel-chat-body">
          <div className="channel-chat-total"><strong>{formatCount(totals?.messageCount)}</strong><span>messages captured</span></div>
          <div className="channel-chat-bars" role="img" aria-label={`Messages were captured on ${chatDays.length} days in this period.`}>{Array.from({ length: view.days }, (_, index) => {
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
      {overview.recentSessions.length === 0 ? <EmptyState title="No streams recorded yet" description="Recent streams will appear here when this channel goes live." /> : <div className="channel-recent-grid">{overview.recentSessions.slice(0, 3).map((session) => <Link className="channel-recent-card" key={session.twitchStreamId} href={channelStreamHref(session.twitchStreamId, returnTo)} prefetch={false}>
        <CategoryArt id={session.latestCategoryId} />
        <div><span className="channel-recent-date">{session.endedAt == null ? <StreamStatusBadge stream={session} now={now} /> : <time dateTime={session.startedAt}>{formatDateTime(session.startedAt)}</time>}</span>
          <h3>{session.latestTitle ?? "Untitled stream"}</h3><p>{session.latestCategoryName ?? "Category unavailable"}</p>
          <span className="channel-caption">{formatDuration(Math.max(0, (Date.parse(session.endedAt ?? session.lastSeenLiveAt) - Date.parse(session.startedAt)) / 1000))}{session.endedAt == null ? " observed" : " streamed"}</span>
        </div>
      </Link>)}</div>}
    </section>
    <details className="channel-methodology"><summary>About these numbers</summary><p>Stream time is split across UTC days and limited to this period. Audience averages are weighted by observed time; observations are carried forward for up to {formatDuration(overview.observationGapSeconds)}, with longer gaps left uncounted. Category shares use only airtime with a known category. Missing data is shown as a dash, not zero.</p><p>Audience observed for {formatDuration(overview.viewerSeconds)}. Categories observed for {formatDuration(overview.categorySeconds)}. Chat totals can take a few minutes to update and only include captured activity.</p></details>
  </div>;
}
