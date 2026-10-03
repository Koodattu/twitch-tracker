import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { earliestChannelPeriodEnd, isChannelDay } from "@twitch-tracker/shared";
import type { ChannelSession, DetailPage } from "@twitch-tracker/shared";
import { getApiData, getDetailPageNumber, getPublicApiInit } from "../../../api-client";
import { DetailPagination, DetailUnavailable } from "../../../detail-ui";
import { ChannelSessionList } from "../session-list";
import { channelViewQuery, readChannelView, type ChannelSearch } from "../channel-view";
import { EmptyState } from "../../../ui";

export const metadata: Metadata = { title: "Channel streams" };

export default async function ChannelStreamsPage({ params, searchParams }: { params: Promise<{ login: string }>; searchParams: Promise<ChannelSearch> }) {
  const { login } = await params;
  const search = await searchParams;
  const page = getDetailPageNumber(typeof search.page === "string" ? search.page : undefined);
  const today = new Date().toISOString().slice(0, 10);
  const day = isChannelDay(search.day, today) ? search.day : undefined;
  const view = readChannelView(search, today);
  const pathname = `/channels/${encodeURIComponent(login)}/streams`;
  // A newly chosen history day must remain inspectable when returning to Overview.
  // Normalize on the server so native GET forms also work before hydration.
  if (day != null && view.day == null) {
    const end = day < earliestChannelPeriodEnd ? earliestChannelPeriodEnd : day;
    const query = new URLSearchParams(channelViewQuery({ ...view, end, day, days: day < earliestChannelPeriodEnd ? 90 : view.days }));
    if (page > 1) query.set("page", String(page));
    redirect(`${pathname}?${query}`);
  }
  const filters = Object.fromEntries(new URLSearchParams(channelViewQuery(view)));
  const allStreams = `${pathname}?${channelViewQuery({ ...view, day: undefined })}`;
  const sessions = await getApiData<DetailPage<ChannelSession>>(`/api/channels/${encodeURIComponent(login)}/sessions?${new URLSearchParams({ page: String(page), ...(day == null ? {} : { day }) })}`, await getPublicApiInit());
  return <section className="panel">
    <div className="panel-header"><div className="panel-heading"><h2>Stream history</h2><p>{day == null ? "All observed sessions, newest first" : `Active on ${day} · UTC · Includes streams that began earlier`}</p></div>{day == null ? null : <Link className="button button-secondary" href={allStreams} prefetch={false}>All dates</Link>}</div>
    <form className="channel-history-filter" action={pathname}>
      {Object.entries(filters).filter(([key]) => key !== "day").map(([key, value]) => <input key={key} name={key} value={value} type="hidden" />)}
      <label>Active on (UTC)<input type="date" name="day" key={day ?? "all"} defaultValue={day} min="2010-10-04" max={today} required /></label><button className="button button-secondary" type="submit">Find streams</button>
    </form>
    {search.day != null && day == null ? <p className="data-note" role="status">That date was invalid. Showing all dates; choose a valid UTC day to filter.</p> : null}
    {sessions == null ? <DetailUnavailable /> : sessions.items.length === 0 ? <EmptyState title={day == null ? "No sessions on this page" : `No streams on ${day}${page > 1 ? " on this page" : ""}`} description="Try another date or browse all observed streams." action={<Link className="button button-secondary" href={allStreams} prefetch={false}>Browse all streams</Link>} /> : <><ChannelSessionList sessions={sessions.items} /><DetailPagination page={sessions.page} hasMore={sessions.hasMore} pathname={pathname} filters={filters} /></>}
  </section>;
}
