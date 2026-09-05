import type { StreamEvent } from "@twitch-tracker/shared";
import { formatCount, formatDateTime, formatStatus } from "../../format";
import { EmptyState, StatusPill } from "../../ui";

export { DetailPagination, DetailUnavailable } from "../../detail-ui";

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
