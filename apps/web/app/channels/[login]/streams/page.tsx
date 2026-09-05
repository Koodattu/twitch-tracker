import type { Metadata } from "next";
import type { ChannelSession, DetailPage } from "@twitch-tracker/shared";
import { getApiData, getDetailPageNumber, getPublicApiInit } from "../../../api-client";
import { DetailPagination, DetailUnavailable } from "../../../detail-ui";
import { ChannelSessionList } from "../session-list";

export const metadata: Metadata = { title: "Channel streams" };

export default async function ChannelStreamsPage({ params, searchParams }: { params: Promise<{ login: string }>; searchParams: Promise<{ page?: string }> }) {
  const { login } = await params;
  const page = getDetailPageNumber((await searchParams).page);
  const sessions = await getApiData<DetailPage<ChannelSession>>(`/api/channels/${encodeURIComponent(login)}/sessions?page=${page}`, await getPublicApiInit());
  return <section className="panel">
    <div className="panel-header"><div className="panel-heading"><h2>Stream history</h2><p>All observed sessions, newest first</p></div></div>
    {sessions == null ? <DetailUnavailable /> : <><ChannelSessionList sessions={sessions.items} /><DetailPagination page={sessions.page} hasMore={sessions.hasMore} pathname={`/channels/${encodeURIComponent(login)}/streams`} /></>}
  </section>;
}
