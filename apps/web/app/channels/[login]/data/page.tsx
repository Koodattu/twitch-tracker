import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import type { ChannelBucket, ChannelDay, ChannelObservation, DetailPage } from "@twitch-tracker/shared";
import { getApiData, getDetailPageNumber, getPublicApiInit } from "../../../api-client";
import { DetailTable } from "../../../detail-ui";
import { formatCount, formatDateTime, formatDuration, formatStatus } from "../../../format";

export const metadata: Metadata = { title: "Channel data" };
const views = { daily: "Daily figures", observations: "Viewer observations", buckets: "Activity detail" };
type View = keyof typeof views;

export default async function ChannelDataPage({ params, searchParams }: { params: Promise<{ login: string }>; searchParams: Promise<{ page?: string; view?: string }> }) {
  const { login } = await params;
  const search = await searchParams;
  const view: View = search.view != null && Object.hasOwn(views, search.view) ? search.view as View : "daily";
  const page = getDetailPageNumber(search.page);
  const pathname = `/channels/${encodeURIComponent(login)}/data`;
  return <>
    <nav className="stream-tabs stream-data-tabs" aria-label="Channel data views">{Object.entries(views).map(([key, label]) => <Link href={`${pathname}?view=${key}`} key={key} prefetch={false} aria-current={view === key ? "page" : undefined}>{label}</Link>)}</nav>
    <section className="panel"><div className="panel-header"><div className="panel-heading"><h2>{views[view]}</h2><p>All retained dates, newest first</p></div></div>
      <ChannelDataTable login={login} view={view} page={page} pathname={pathname} />
    </section>
    <p className="data-note">Chat figures include captured activity only. Stream time is grouped by the date each session started.</p>
  </>;
}

async function ChannelDataTable({ login, view, page, pathname }: { login: string; view: View; page: number; pathname: string }) {
  const init = await getPublicApiInit();
  const endpoint = `/api/channels/${encodeURIComponent(login)}/${view}?page=${page}`;
  function table<T>(data: DetailPage<T> | null, columns: string[], row: (item: T) => ReactNode) {
    return <DetailTable data={data} columns={columns} row={row} label={views[view]} pathname={pathname} filters={{ view }} />;
  }
  switch (view) {
    case "daily": return table(await getApiData<DetailPage<ChannelDay>>(endpoint, init), ["Day (UTC)", "Streams started", "Stream time", "Peak viewers", "Avg viewers", "Messages"], (day) =>
      <tr key={day.day}><td className="time-cell">{day.day}</td><td className="number-cell">{formatCount(day.streamCount)}</td><td className="number-cell">{formatDuration(day.liveSeconds)}</td><td className="number-cell">{formatCount(day.viewerCountMax)}</td><td className="number-cell">{formatCount(day.viewerCountAvg)}</td><td className="number-cell">{formatCount(day.messageCount)}</td></tr>);
    case "observations": return table(await getApiData<DetailPage<ChannelObservation>>(endpoint, init), ["Observed", "Viewers", "Stream", "Category"], (point) =>
      <tr key={point.id}><td className="time-cell">{formatDateTime(point.observedAt)}</td><td className="number-cell">{formatCount(point.viewerCount)}</td><td className="message-cell"><Link href={`/streams/${encodeURIComponent(point.twitchStreamId)}`} prefetch={false}>{point.title ?? "Open session"}</Link></td><td>{point.categoryName ?? "Unknown"}</td></tr>);
    case "buckets": return table(await getApiData<DetailPage<ChannelBucket>>(endpoint, init), ["Interval (UTC)", "Minutes", "Stream", "Avg / peak viewers", "Messages", "Active chatters", "Joins / parts", "Events"], (bucket) =>
      <tr key={`${bucket.twitchStreamId}:${bucket.bucketStart}:${bucket.bucketMinutes}`}><td className="time-cell">{formatDateTime(bucket.bucketStart)}</td><td className="number-cell">{bucket.bucketMinutes}</td><td><Link href={`/streams/${encodeURIComponent(bucket.twitchStreamId)}`} prefetch={false}>Open session</Link></td><td className="number-cell">{formatCount(bucket.viewerCountAvg)} / {formatCount(bucket.viewerCountMax)}</td><td className="number-cell">{formatCount(bucket.messageCount)}</td><td className="number-cell">{formatCount(bucket.activeChatterCount)}</td><td className="number-cell">{formatCount(bucket.joinCount)} / {formatCount(bucket.partCount)}</td><td>{Object.entries(bucket.eventCounts).map(([type, count]) => `${formatStatus(type)}: ${formatCount(count)}`).join(", ") || "—"}</td></tr>);
  }
}
