import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import type { StreamBucket, StreamDetailPage, StreamMembership, StreamObservation, StreamPresence } from "@twitch-tracker/shared";
import { getApiData, getAuthenticatedApiInit, getPublicApiInit } from "../../../api-client";
import { formatCount, formatDateTime, formatStatus } from "../../../format";
import { StatusPill } from "../../../ui";
import { DetailTable, DetailUnavailable } from "../../../detail-ui";
import { getDetailPageNumber, getStreamSession } from "../stream-data";

export const metadata: Metadata = { title: "Stream data" };

const views = {
  observations: "Viewer observations",
  buckets: "Activity detail",
  membership: "Membership signals",
  presence: "Presence snapshots"
};
type View = keyof typeof views;

export default async function StreamDataPage({ params, searchParams }: { params: Promise<{ streamId: string }>; searchParams: Promise<{ page?: string; view?: string }> }) {
  const { streamId } = await params;
  const search = await searchParams;
  const view: View = search.view != null && Object.hasOwn(views, search.view) ? search.view as View : "observations";
  const page = getDetailPageNumber(search.page);
  const stream = await getStreamSession(streamId);
  const privateData = view === "membership" || view === "presence";
  const pathname = `/streams/${encodeURIComponent(streamId)}/data`;
  return <>
    <nav className="stream-tabs stream-data-tabs" aria-label="Stream data views">{(Object.entries(views) as [View, string][])
      .filter(([key]) => stream?.canInspectRaw || key === "observations" || key === "buckets")
      .map(([key, label]) => <Link href={`${pathname}?view=${key}`} key={key} prefetch={false} aria-current={view === key ? "page" : undefined}>{label}</Link>)}
    </nav>
    <section className="panel">
      <div className="panel-header"><div className="panel-heading"><h2>{views[view]}</h2><p>Newest observations first</p></div>{privateData ? <StatusPill tone="accent">Private detail</StatusPill> : null}</div>
      {privateData && !stream?.canInspectRaw ? <DetailUnavailable privateData /> : <DataTable streamId={streamId} view={view} page={page} pathname={pathname} />}
    </section>
    {privateData ? <p className="data-note">Membership and presence observations describe chat-room activity. They do not establish who watched the stream or for how long.</p> : null}
  </>;
}

async function DataTable({ streamId, view, page, pathname }: { streamId: string; view: View; page: number; pathname: string }) {
  const privateData = view === "membership" || view === "presence";
  const init = await (privateData ? getAuthenticatedApiInit() : getPublicApiInit());
  const endpoint = `${privateData ? "/api/private/streams" : "/api/streams"}/${encodeURIComponent(streamId)}/${view}?page=${page}`;
  function table<T>(data: StreamDetailPage<T> | null, columns: string[], row: (item: T) => ReactNode) {
    return <DetailTable data={data} columns={columns} row={row} label={views[view]} pathname={pathname} filters={{ view }} privateData={privateData} />;
  }
  switch (view) {
    case "observations": return table(await getApiData<StreamDetailPage<StreamObservation>>(endpoint, init), ["Observed", "Viewers", "Category", "Title"], (item) =>
      <tr key={item.id}><td className="time-cell">{formatDateTime(item.observedAt)}</td><td className="number-cell">{formatCount(item.viewerCount)}</td><td>{item.categoryName ?? "Unknown"}</td><td className="message-cell">{item.title ?? "Untitled"}</td></tr>);
    case "buckets": return table(await getApiData<StreamDetailPage<StreamBucket>>(endpoint, init), ["Interval (UTC)", "Minutes", "Avg / peak viewers", "Messages", "Active chatters", "Joins / parts", "Events"], (item) =>
      <tr key={`${item.bucketStart}:${item.bucketMinutes}`}><td className="time-cell">{formatDateTime(item.bucketStart)}</td><td className="number-cell">{item.bucketMinutes}</td><td className="number-cell">{formatCount(item.viewerCountAvg)} / {formatCount(item.viewerCountMax)}</td><td className="number-cell">{formatCount(item.messageCount)}</td><td className="number-cell">{formatCount(item.activeChatterCount)}</td><td className="number-cell">{formatCount(item.joinCount)} / {formatCount(item.partCount)}</td><td>{Object.entries(item.eventCounts).map(([name, count]) => `${formatStatus(name)}: ${formatCount(count)}`).join(", ") || "—"}</td></tr>);
    case "membership": return table(await getApiData<StreamDetailPage<StreamMembership>>(endpoint, init), ["Time", "Chatter", "Event", "Source", "Confidence"], (item) =>
      <tr key={item.id}><td className="time-cell">{formatDateTime(item.eventAt ?? item.receivedAt)}</td><td>{item.chatterLogin == null ? "Unknown chatter" : <Link href={`/chatters/${item.chatterLogin}`} prefetch={false}>{item.chatterLogin}</Link>}</td><td><StatusPill tone={item.eventType === "join" ? "success" : "neutral"}>{formatStatus(item.eventType)}</StatusPill></td><td>{formatStatus(item.source)}</td><td className="number-cell">{item.confidence}%</td></tr>);
    case "presence": return table(await getApiData<StreamDetailPage<StreamPresence>>(endpoint, init), ["Sampled", "Chatters", "Pages", "Source", "Confidence", "Status"], (item) =>
      <tr key={item.id}><td className="time-cell">{formatDateTime(item.sampledAt)}</td><td className="number-cell">{formatCount(item.chatterCount)}</td><td className="number-cell">{formatCount(item.pageCount)}</td><td>{formatStatus(item.source)}</td><td className="number-cell">{item.confidence}%</td><td><StatusPill tone={item.requestStatus === "succeeded" ? "success" : "warning"}>{formatStatus(item.requestStatus)}</StatusPill></td></tr>);
  }
}
