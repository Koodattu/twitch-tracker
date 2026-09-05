import Link from "next/link";
import type { StreamEvent } from "@twitch-tracker/shared";
import { formatCount, formatDateTime, formatStatus } from "../../format";
import { EmptyState, StatusPill } from "../../ui";

export function DetailUnavailable({ privateData = false }: { privateData?: boolean }) {
  return <EmptyState title="Details unavailable" description={privateData ? "These records require private access. Check your account or try again later." : "These records could not be loaded. Please try again later."} />;
}

export function DetailPagination({ page, hasMore, pathname, filters = {} }: { page: number; hasMore: boolean; pathname: string; filters?: Record<string, string> }) {
  const href = (target: number) => `${pathname}?${new URLSearchParams({ ...filters, page: String(target) })}`;
  return <div className="pagination"><span>Page {formatCount(page)} · Up to 50 records</span><div className="pagination-actions">
    {page > 1 ? <Link className="button button-secondary button-compact" href={href(page - 1)} prefetch={false}>Newer</Link> : null}
    {hasMore ? <Link className="button button-secondary button-compact" href={href(page + 1)} prefetch={false}>Load older</Link> : null}
  </div></div>;
}

export function EventTimeline({ events }: { events: StreamEvent[] }) {
  if (events.length === 0) return <EmptyState title="No channel events" description="No retained channel events are linked to this stream." />;
  return <ol className="stream-event-list">{events.map((event) => <li key={event.id}>
    <span className="stream-event-dot" aria-hidden="true" />
    <div><strong>{formatStatus(event.eventType.replaceAll(".", "_"))}</strong>{event.actor == null ? null : <span className="muted"> · {event.actor}</span>}
      <div className="message-meta"><time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time><span>{formatStatus(event.source)}</span></div>
    </div>
    {event.viewerCount == null ? null : <StatusPill tone="accent">{formatCount(event.viewerCount)} viewers</StatusPill>}
  </li>)}</ol>;
}
