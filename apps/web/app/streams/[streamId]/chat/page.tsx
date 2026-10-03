import Link from "next/link";
import type { Metadata } from "next";
import type { StreamDetailPage, StreamMessage } from "@twitch-tracker/shared";
import { getApiData, getAuthenticatedApiInit } from "../../../api-client";
import { formatDateTime, formatStatus } from "../../../format";
import { EmptyState, StatusPill } from "../../../ui";
import { DetailPagination, DetailUnavailable } from "../detail-ui";
import { getDetailPageNumber, getStreamSession } from "../stream-data";
import { streamViewParams } from "../stream-view";

export const metadata: Metadata = { title: "Stream chat" };

export default async function StreamChatPage({ params, searchParams }: { params: Promise<{ streamId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { streamId } = await params;
  const stream = await getStreamSession(streamId);
  if (!stream?.canInspectRaw) return <section className="panel"><DetailUnavailable privateData /></section>;
  const search = await searchParams;
  const page = getDetailPageNumber(typeof search.page === "string" ? search.page : undefined);
  const inspection = streamViewParams(search);
  const filterValue = (value: string | string[] | undefined) => typeof value === "string" ? value : "";
  const filters = { chatter: filterValue(search.chatter).trim().slice(0, 100), from: filterValue(search.from), to: filterValue(search.to) };
  const query = new URLSearchParams({ page: String(page), chatter: filters.chatter });
  let invalidTime = false;
  for (const name of ["from", "to"] as const) {
    const value = filters[name];
    if (value === "") continue;
    const date = new Date(`${value}Z`);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 16) !== value) invalidTime = true;
    else query.set(name, date.toISOString());
  }
  if (filters.from !== "" && filters.to !== "" && filters.from >= filters.to) invalidTime = true;
  const messages = invalidTime ? null : await getApiData<StreamDetailPage<StreamMessage>>(`/api/private/streams/${encodeURIComponent(streamId)}/messages?${query}`, await getAuthenticatedApiInit());
  const pathname = `/streams/${encodeURIComponent(streamId)}/chat`;
  return <>
    <form className="stream-filters" action={pathname} method="get">
      {[...inspection].map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      <label>Chatter login<input className="search-input" name="chatter" defaultValue={filters.chatter} maxLength={100} placeholder="Any chatter" /></label>
      <label>Captured from (UTC)<input className="search-input" type="datetime-local" name="from" defaultValue={filters.from} /></label>
      <label>Captured before (UTC)<input className="search-input" type="datetime-local" name="to" defaultValue={filters.to} /></label>
      <button className="button" type="submit">Filter chat</button><Link className="button button-secondary" href={inspection.size === 0 ? pathname : `${pathname}?${inspection}`} prefetch={false}>Clear</Link>
    </form>
    <section className="panel">
      <div className="panel-header"><div className="panel-heading"><h2>Captured messages</h2><p>Newest captured messages first</p></div><StatusPill tone="accent">Private detail</StatusPill></div>
      {invalidTime ? <EmptyState title="Check the time range" description="Enter valid UTC times, with the end after the start." /> : messages == null ? <DetailUnavailable privateData /> : <>
        {messages.items.length === 0 ? <EmptyState title="No matching messages" description="No retained messages match this page and these filters." /> : <div className="message-list">{messages.items.map((message) => <article className="message-item" key={message.messageId}>
          <div className="message-meta"><strong>{message.chatterLogin == null ? "Unknown chatter" : <Link href={`/chatters/${message.chatterLogin}`} prefetch={false}>{message.chatterDisplayName ?? message.chatterLogin}</Link>}</strong><time dateTime={message.sentAt ?? message.receivedAt}>{formatDateTime(message.sentAt ?? message.receivedAt)}</time><span>{formatStatus(message.source)} · {formatStatus(message.messageType)}</span></div>
          <p className="message-body">{message.rawText ?? "Message text has been redacted."}</p>
        </article>)}</div>}
        <DetailPagination page={messages.page} hasMore={messages.hasMore} pathname={pathname} filters={{ ...filters, ...Object.fromEntries(inspection) }} />
      </>}
    </section>
    <p className="data-note">Messages are available only where chat was captured and records are still retained. Time filters use capture time; message timestamps show send time when available.</p>
  </>;
}
