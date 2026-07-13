import Link from "next/link";
import { getApiData, getAuthenticatedApiInit } from "../../api-client";
import { formatCount, formatDateTime, formatStatus } from "../../format";
import { EmptyState, MetricCard, StatusPill } from "../../ui";

type MessageArchive = {
  summary: {
    messageCount: number;
    chatterCount: number;
    channelCount: number;
    streamCount: number;
  };
  messages: Array<{
    messageId: string;
    chatterUserId: string | null;
    chatterLogin: string | null;
    broadcasterUserId: string;
    broadcasterLogin: string | null;
    broadcasterDisplayName: string | null;
    twitchStreamId: string | null;
    streamTitle: string | null;
    streamStartedAt: string | null;
    sentAt: string | null;
    receivedAt: string;
    rawText: string | null;
    source: string;
    messageType: string;
    deletedAt: string | null;
    clearedAt: string | null;
  }>;
  pagination: {
    page: number;
    pageSize: number;
    totalMatches: number;
    totalPages: number;
  };
  query: string;
};

export default async function MessageArchivePage({ searchParams }: { searchParams: Promise<{ page?: string; q?: string }> }) {
  const search = await searchParams;
  const page = Math.max(1, Number.parseInt(search.page ?? "1", 10) || 1);
  const q = (search.q ?? "").slice(0, 100);
  const apiInit = await getAuthenticatedApiInit();
  const archive = await getApiData<MessageArchive>(`/api/internal/messages?page=${page}&q=${encodeURIComponent(q)}`, apiInit);

  return (
    <>
      <section className="page-title page-title-wide">
        <span className="eyebrow">Admin · Captured data</span>
        <div className="page-heading-row"><div><h1>Message archive</h1><p>Browse retained messages across chatters, channels, and linked stream sessions in every deployment mode.</p></div><StatusPill tone="accent">Admin only</StatusPill></div>
      </section>

      {archive == null ? (
        <section className="panel"><EmptyState title="Admin archive unavailable" description="Log in with an administrator account, or check that the API and database are available." action={<Link className="button" href="/me">Go to login</Link>} /></section>
      ) : (
        <>
          <section className="stat-row" aria-label="Message archive summary">
            <MetricCard label="Retained messages" value={formatCount(archive.summary.messageCount)} />
            <MetricCard label="Observed chatters" value={formatCount(archive.summary.chatterCount)} />
            <MetricCard label="Channels" value={formatCount(archive.summary.channelCount)} />
            <MetricCard label="Linked streams" value={formatCount(archive.summary.streamCount)} />
          </section>

          <form className="search-bar" action="/internal/messages" method="get">
            <label className="sr-only" htmlFor="message-search">Search messages</label>
            <input className="search-input" id="message-search" name="q" defaultValue={archive.query} placeholder="Search chatter, channel, stream ID, title, or message text" maxLength={100} />
            <button className="button" type="submit">Search archive</button>
            {archive.query === "" ? null : <Link className="button button-secondary" href="/internal/messages">Clear</Link>}
          </form>

          <section className="panel">
            <div className="panel-header">
              <div className="panel-heading"><h2>{archive.query === "" ? "All captured messages" : `Results for “${archive.query}”`}</h2><p>Newest retained rows first</p></div>
              <StatusPill>{formatCount(archive.pagination.totalMatches)} matches</StatusPill>
            </div>
            {archive.messages.length === 0 ? (
              <EmptyState title="No matching messages" description="Try a different chatter, channel, stream, or message search." />
            ) : (
              <div className="table-scroll" role="region" aria-label="Captured message archive" tabIndex={0}>
                <table className="table">
                  <thead><tr><th scope="col">Captured</th><th scope="col">Chatter</th><th scope="col">Channel and stream</th><th scope="col">Message</th><th scope="col">Source</th></tr></thead>
                  <tbody>
                    {archive.messages.map((message) => {
                      const isRedacted = message.rawText == null;
                      const recordStatusAt = message.deletedAt ?? message.clearedAt;
                      const recordStatus = message.deletedAt != null
                        ? "Deleted"
                        : message.clearedAt != null
                          ? "Cleared"
                          : isRedacted
                            ? "Redacted"
                            : "Retained";
                      return (
                        <tr key={message.messageId}>
                          <td className="time-cell">{formatDateTime(message.sentAt ?? message.receivedAt)}</td>
                          <td>
                            <div className="cell-stack">
                              {message.chatterLogin == null ? <strong>Unknown chatter</strong> : <Link href={`/chatters/${message.chatterLogin}`}><strong>{message.chatterLogin}</strong></Link>}
                              <span>{message.chatterUserId ?? "No hydrated user ID"}</span>
                            </div>
                          </td>
                          <td>
                            <div className="cell-stack">
                              {message.broadcasterLogin == null ? <strong>{message.broadcasterUserId}</strong> : <Link href={`/channels/${message.broadcasterLogin}`}><strong>{message.broadcasterDisplayName ?? message.broadcasterLogin}</strong></Link>}
                              {message.twitchStreamId == null ? <span>No linked stream</span> : <Link href={`/streams/${message.twitchStreamId}`}>{message.streamTitle ?? `Stream ${message.twitchStreamId}`}</Link>}
                            </div>
                          </td>
                          <td className="message-cell">{isRedacted ? <span className="muted">Message text redacted by retention or privacy controls.</span> : message.rawText}</td>
                          <td>
                            <div className="cell-stack">
                              <StatusPill tone={recordStatus === "Retained" ? "success" : "warning"}>{recordStatus}</StatusPill>
                              <span>{formatStatus(message.source)} · {formatStatus(message.messageType)}</span>
                              {recordStatusAt == null ? null : (
                                <span>{recordStatus} {formatDateTime(recordStatusAt)}</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="pagination">
              <span>Page {archive.pagination.page} of {archive.pagination.totalPages} · {formatCount(archive.pagination.pageSize)} rows per page</span>
              <div className="pagination-actions">
                {archive.pagination.page > 1 ? <Link className="button button-secondary button-compact" href={pageHref(archive.pagination.page - 1, archive.query)}>Newer</Link> : null}
                {archive.pagination.page < archive.pagination.totalPages ? <Link className="button button-secondary button-compact" href={pageHref(archive.pagination.page + 1, archive.query)}>Older</Link> : null}
              </div>
            </div>
          </section>

          <p className="data-note">This archive includes only messages the tracker captured while a chat assignment was active. Retention, redaction, privacy deletion, missing hydration, and unmatched stream timing can leave text or context absent.</p>
        </>
      )}
    </>
  );
}

function pageHref(page: number, query: string) {
  const params = new URLSearchParams({ page: String(page) });
  if (query !== "") params.set("q", query);
  return `/internal/messages?${params.toString()}`;
}
