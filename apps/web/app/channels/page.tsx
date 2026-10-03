import type { Metadata } from "next";
import Link from "next/link";
import type { ChannelDirectoryEntry, DetailPage } from "@twitch-tracker/shared";
import { getApiData, getDetailPageNumber, getPublicApiInit } from "../api-client";
import { formatDateTime, formatRelativeTime } from "../format";
import { Avatar, EmptyState, StatusPill } from "../ui";
import { RetryButton } from "../retry-button";

export const metadata: Metadata = { title: "Channels" };

export default async function ChannelsPage({ searchParams }: { searchParams: Promise<{ q?: string | string[]; page?: string | string[] }> }) {
  const search = await searchParams;
  const query = typeof search.q === "string" ? search.q.trim().slice(0, 100) : "";
  const page = getDetailPageNumber(typeof search.page === "string" ? search.page : undefined);
  const filters = query === "" ? {} : { q: query };
  const href = (target: number) => `/channels?${new URLSearchParams({ ...filters, page: String(target) })}`;
  const channels = await getApiData<DetailPage<ChannelDirectoryEntry>>(`/api/channels?${new URLSearchParams({ ...filters, page: String(page) })}`, { ...await getPublicApiInit(), cache: "no-store" });
  const now = new Date();

  return <>
    <section className="page-title page-title-wide">
      <h1>Channels</h1>
      <p>Find channels with observed Finnish streams, including past broadcasts. Open a channel for its audience trends, categories and stream history.</p>
    </section>
    <form className="live-search" role="search" action="/channels" method="get">
      <label htmlFor="channel-search">Search channels</label>
      <div className="live-search-controls">
        <input className="search-input" id="channel-search" name="q" type="search" defaultValue={query} key={query} maxLength={100} placeholder="Channel name or Twitch login" />
        <button className="button" type="submit">Search</button>
        {query === "" ? null : <Link className="button button-secondary" href="/channels" prefetch={false}>Clear search</Link>}
      </div>
    </form>
    <section className="panel channel-directory" aria-labelledby="channel-results-heading">
      <div className="panel-header"><div className="panel-heading">
        <h2 id="channel-results-heading">{query === "" ? "Observed Finnish channels" : `Results for “${query}”`}</h2>
        <p>Latest Finnish broadcast first · Live status reflects the latest observation.</p>
      </div></div>
      {channels == null ? <EmptyState title="Channels are unavailable" description="The channel directory could not be loaded. Try again to keep your search." action={<RetryButton />} />
        : channels.items.length === 0 ? <EmptyState
          title={page > 1 ? "No channels on this page" : query === "" ? "No channels recorded yet" : "No matching channels"}
          description={page > 1 ? "Return to the first page of these results." : query === "" ? "Channels will appear after a Finnish stream has been observed." : "Try part of the channel name or its Twitch login. Only channels already observed by this tracker are included."}
          action={page > 1 ? <Link className="button button-secondary" href={href(1)} prefetch={false}>First page</Link> : query === "" ? undefined : <Link className="button button-secondary" href="/channels" prefetch={false}>Browse channels</Link>} />
        : <ul className="channel-directory-list">{channels.items.map(channel => {
          const name = channel.displayName ?? channel.login;
          return <li className="channel-directory-row" key={channel.twitchUserId}>
            <Link className="channel-directory-identity" href={`/channels/${encodeURIComponent(channel.login)}`} prefetch={false}>
              <Avatar name={name} src={channel.profileImageUrl} />
              <span><strong>{name}</strong><span>@{channel.login}</span></span>
            </Link>
            <div className="channel-directory-broadcast"><span className="muted">Latest Finnish stream</span>
              <Link href={`/streams/${encodeURIComponent(channel.latestStreamId)}`} prefetch={false}>{channel.latestTitle ?? "Untitled stream"}</Link>
              <span className="muted">{channel.latestCategoryName ?? "Category unavailable"}</span>
            </div>
            <div className="channel-directory-time">
              {channel.endedAt == null ? <StatusPill tone="success">Live now</StatusPill> : <span>Ended {formatRelativeTime(channel.endedAt, now)}</span>}
              <time dateTime={channel.startedAt}>Started {formatDateTime(channel.startedAt)}</time>
            </div>
          </li>;
        })}</ul>}
      {channels == null || (channels.items.length === 0 && page === 1) ? null : <nav className="pagination" aria-label="Channel result pages">
        <span>Page {page} · {channels.items.length} {channels.items.length === 1 ? "channel" : "channels"}</span>
        <div className="pagination-actions">
          {page > 1 ? <Link className="button button-secondary" href={href(page - 1)} prefetch={false}>Previous page</Link> : null}
          {channels.hasMore ? <Link className="button button-secondary" href={href(page + 1)} prefetch={false}>Next page</Link> : null}
        </div>
      </nav>}
    </section>
  </>;
}
