import type { Metadata } from "next";
import Link from "next/link";
import type { StreamDetailPage, StreamEvent } from "@twitch-tracker/shared";
import { getApiData, getPublicApiInit } from "../../../api-client";
import { DetailPagination, DetailUnavailable, EventTimeline } from "../detail-ui";
import { getDetailPageNumber } from "../stream-data";
import { readEventRange, streamViewParams } from "../stream-view";
import { EmptyState } from "../../../ui";

export const metadata: Metadata = { title: "Stream events" };

export default async function StreamEventsPage({ params, searchParams }: { params: Promise<{ streamId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { streamId } = await params;
  const search = await searchParams;
  const page = getDetailPageNumber(typeof search.page === "string" ? search.page : undefined);
  const { filters, query, invalid } = readEventRange(search);
  const view = streamViewParams(search);
  const base = `/streams/${encodeURIComponent(streamId)}`;
  const pathname = `${base}/events`;
  const clearHref = view.size === 0 ? pathname : `${pathname}?${view}`;
  query.set("page", String(page));
  const events = invalid ? null : await getApiData<StreamDetailPage<StreamEvent>>(`/api/streams/${encodeURIComponent(streamId)}/events?${query}`, await getPublicApiInit());
  return <>
    <form className="stream-filters" action={pathname} method="get">
      {[...view].map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <label>From (UTC)<input className="search-input" type="datetime-local" step="any" name="from" defaultValue={filters.from} /></label>
      <label>Before (UTC)<input className="search-input" type="datetime-local" step="any" name="to" defaultValue={filters.to} /></label>
      <button className="button" type="submit">Filter events</button>
      <Link className="button button-secondary" href={clearHref} prefetch={false}>All events</Link>
    </form>
    <section className="panel">
    <div className="panel-header"><div className="panel-heading"><h2>Channel events</h2><p>Channel events and incoming or outgoing raids, newest first</p></div></div>
    {invalid ? <EmptyState title="Check the time range" description="Enter valid UTC times, with the end after the start." /> : events == null ? <DetailUnavailable /> : <>
      {events.items.length === 0 && (filters.from || filters.to) ? <EmptyState title="No events in this range" description="No retained channel events or raids match these times. Try a wider range or return to all events." action={<Link className="button button-secondary" href={clearHref} prefetch={false}>Show all events</Link>} /> : <EventTimeline events={events.items} />}
      <DetailPagination page={events.page} hasMore={events.hasMore} pathname={pathname} filters={{ ...filters, ...Object.fromEntries(view) }} />
    </>}
    </section>
    <p className="data-note">Times are UTC. The start is included and the end is excluded. Events occurring near an audience change do not establish its cause.</p>
  </>;
}
