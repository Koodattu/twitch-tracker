import type { Metadata } from "next";
import type { StreamDetailPage, StreamEvent } from "@twitch-tracker/shared";
import { getApiData, getPublicApiInit } from "../../../api-client";
import { DetailPagination, DetailUnavailable, EventTimeline } from "../detail-ui";
import { getDetailPageNumber } from "../stream-data";

export const metadata: Metadata = { title: "Stream events" };

export default async function StreamEventsPage({ params, searchParams }: { params: Promise<{ streamId: string }>; searchParams: Promise<{ page?: string }> }) {
  const { streamId } = await params;
  const page = getDetailPageNumber((await searchParams).page);
  const events = await getApiData<StreamDetailPage<StreamEvent>>(`/api/streams/${encodeURIComponent(streamId)}/events?page=${page}`, await getPublicApiInit());
  return <section className="panel">
    <div className="panel-header"><div className="panel-heading"><h2>Channel events</h2><p>Channel events and incoming or outgoing raids, newest first</p></div></div>
    {events == null ? <DetailUnavailable /> : <><EventTimeline events={events.items} /><DetailPagination page={events.page} hasMore={events.hasMore} pathname={`/streams/${encodeURIComponent(streamId)}/events`} /></>}
  </section>;
}
