import Link from "next/link";
import { getApiData, getAuthenticatedApiInit } from "../../api-client";
import { formatCount, formatDateTime, formatDuration, formatStatus } from "../../format";
import { Avatar, EmptyState, MetricCard, StatusPill } from "../../ui";
import { StreamActivityChart } from "./activity-chart";

type StreamSession = {
  twitchStreamId: string;
  broadcasterUserId: string;
  broadcasterLogin: string | null;
  broadcasterDisplayName: string | null;
  broadcasterProfileImageUrl: string | null;
  latestTitle: string | null;
  latestCategoryName: string | null;
  language: string | null;
  startedAt: string;
  endedAt: string | null;
  firstSeenAt: string;
  lastSeenLiveAt: string;
};

type StreamActivity = {
  totals: {
    viewerCountMax: number | null;
    viewerCountAvg: number | null;
    messageCount: number;
    joinCount: number;
    partCount: number;
    activeChatterCountMax: number | null;
  };
  snapshots: Array<{ observedAt: string; viewerCount: number | null; title: string | null; categoryName: string | null }>;
  buckets: Array<{
    bucketStart: string;
    bucketMinutes: number;
    viewerCountAvg: number | null;
    messageCount: number;
    joinCount: number;
    partCount: number;
    activeChatterCount: number | null;
    eventCounts: Record<string, number>;
  }>;
  events: Array<{ id: string; eventType: string; actorUserId: string | null; occurredAt: string; source: string; sourceEventId: string | null }>;
  raids: Array<{ id: string; sourceBroadcasterUserId: string | null; targetBroadcasterUserId: string | null; viewerCount: number | null; occurredAt: string }>;
};

type PrivateStreamRaw = {
  messages: Array<{
    messageId: string;
    chatterUserId: string | null;
    chatterLogin: string | null;
    chatterDisplayName: string | null;
    sentAt: string | null;
    receivedAt: string;
    rawText: string | null;
    source: string;
    messageType: string;
  }>;
  membershipEvents: Array<{
    id: string;
    eventType: string;
    source: string;
    confidence: number;
    chatterUserId: string | null;
    chatterLogin: string | null;
    eventAt: string | null;
    receivedAt: string;
  }>;
  presenceSnapshots: Array<{
    id: string;
    source: string;
    confidence: number;
    sampledAt: string;
    chatterCount: number;
    pageCount: number;
    requestStatus: string;
    latestError: string | null;
  }>;
};

export default async function StreamPage({ params }: { params: Promise<{ streamId: string }> }) {
  const { streamId } = await params;
  const apiInit = await getAuthenticatedApiInit();
  const [stream, activity, raw] = await Promise.all([
    getApiData<StreamSession>(`/api/streams/${streamId}`, apiInit),
    getApiData<StreamActivity>(`/api/streams/${streamId}/activity`, apiInit),
    getApiData<PrivateStreamRaw>(`/api/private/streams/${streamId}/raw`, apiInit)
  ]);
  const chartPoints = (activity?.buckets ?? []).slice().reverse().map((bucket) => ({
    time: new Date(bucket.bucketStart).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }),
    viewers: bucket.viewerCountAvg,
    messages: bucket.messageCount,
    activeChatters: bucket.activeChatterCount
  }));
  const broadcasterName = stream?.broadcasterDisplayName ?? stream?.broadcasterLogin ?? "Unknown channel";
  const durationSeconds = stream == null
    ? 0
    : Math.max(0, Math.floor((new Date(stream.endedAt ?? stream.lastSeenLiveAt).getTime() - new Date(stream.startedAt).getTime()) / 1000));

  return (
    <>
      <section className="page-title page-title-wide">
        <div className="breadcrumbs"><Link href="/">Live streams</Link><span>/</span>{stream?.broadcasterLogin == null ? <span>{broadcasterName}</span> : <Link href={`/channels/${stream.broadcasterLogin}`}>{broadcasterName}</Link>}<span>/</span><span>Stream session</span></div>
        <div className="page-heading-row">
          <div className="identity-heading">
            <Avatar name={broadcasterName} src={stream?.broadcasterProfileImageUrl} size="large" />
            <div><span className="eyebrow">{stream?.latestCategoryName ?? "Stream session"}</span><h1>{stream?.latestTitle ?? streamId}</h1></div>
          </div>
          <StatusPill tone={stream?.endedAt == null && stream != null ? "success" : "neutral"}>{stream == null ? "Unavailable" : stream.endedAt == null ? "Live" : "Ended"}</StatusPill>
        </div>
        <p>{stream == null ? "This stream session could not be loaded." : `${broadcasterName} · ${formatDateTime(stream.startedAt)} · ${formatDuration(durationSeconds)} observed`}</p>
      </section>

      {stream == null ? <div className="callout callout-warning"><div><strong>Stream metadata unavailable</strong><p>The stream may be hidden, missing, or the API may be temporarily unavailable. Accessible aggregate sections are shown below.</p></div></div> : null}

      <section className="stat-row" aria-label="Stream summary">
        <MetricCard label="Peak viewers" value={formatCount(activity?.totals.viewerCountMax)} detail={activity?.totals.viewerCountAvg == null ? "No average yet" : `${formatCount(activity.totals.viewerCountAvg)} average`} />
        <MetricCard label="Messages captured" value={formatCount(activity?.totals.messageCount)} />
        <MetricCard label="Active chatters" value={formatCount(activity?.totals.activeChatterCountMax)} detail="Maximum observed in an activity bucket" />
        <MetricCard label="JOIN / PART" value={activity == null ? "—" : `${formatCount(activity.totals.joinCount)} / ${formatCount(activity.totals.partCount)}`} />
        <MetricCard label="Observed duration" value={stream == null ? "—" : formatDuration(durationSeconds)} />
      </section>

      <section className="panel">
        <div className="panel-header"><div className="panel-heading"><h2>Activity over time</h2><p>Viewer snapshots and captured chat activity use separate scales</p></div><StatusPill>{chartPoints.length} points</StatusPill></div>
        <StreamActivityChart points={chartPoints} />
      </section>

      <section className="panel">
        <div className="panel-header"><div className="panel-heading"><h2>Session timeline</h2><p>Twitch start time and tracker observation window</p></div></div>
        <div className="table-scroll" role="region" aria-label="Stream session timeline" tabIndex={0}>
          <table className="table table-compact"><tbody>
            <tr><th scope="row">Twitch started</th><td className="time-cell">{formatDateTime(stream?.startedAt)}</td></tr>
            <tr><th scope="row">First discovered</th><td className="time-cell">{formatDateTime(stream?.firstSeenAt)}</td></tr>
            <tr><th scope="row">Last seen live</th><td className="time-cell">{formatDateTime(stream?.lastSeenLiveAt)}</td></tr>
            <tr><th scope="row">Ended</th><td className="time-cell">{stream?.endedAt == null ? "Still live or awaiting confirmation" : formatDateTime(stream.endedAt)}</td></tr>
            <tr><th scope="row">Stream ID</th><td className="mono-cell">{streamId}</td></tr>
          </tbody></table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header"><div className="panel-heading"><h2>Viewer snapshots</h2><p>Latest periodic observations</p></div><StatusPill>{activity?.snapshots.length ?? 0} loaded</StatusPill></div>
        {activity == null || activity.snapshots.length === 0 ? <EmptyState title="No viewer snapshots" description="No viewer-count observations are stored for this stream." /> : (
          <div className="table-scroll" role="region" aria-label="Stream viewer snapshots" tabIndex={0}>
            <table className="table"><thead><tr><th scope="col">Observed</th><th scope="col">Viewers</th><th scope="col">Category</th><th scope="col">Title</th></tr></thead><tbody>
              {activity.snapshots.slice(0, 25).map((snapshot) => <tr key={snapshot.observedAt}><td className="time-cell">{formatDateTime(snapshot.observedAt)}</td><td className="number-cell">{formatCount(snapshot.viewerCount)}</td><td>{snapshot.categoryName ?? <span className="muted">Unknown</span>}</td><td className="message-cell">{snapshot.title ?? "Untitled"}</td></tr>)}
            </tbody></table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header"><div className="panel-heading"><h2>Activity buckets</h2><p>Bounded aggregate detail</p></div></div>
        {activity == null || activity.buckets.length === 0 ? <EmptyState title="No activity buckets" description="Aggregation has not produced activity buckets for this stream." /> : (
          <div className="table-scroll" role="region" aria-label="Stream activity buckets" tabIndex={0}>
            <table className="table"><thead><tr><th scope="col">Bucket</th><th scope="col">Viewers</th><th scope="col">Messages</th><th scope="col">Active chatters</th><th scope="col">JOIN / PART</th><th scope="col">Events</th></tr></thead><tbody>
              {activity.buckets.slice(0, 30).map((bucket) => <tr key={bucket.bucketStart}><td className="time-cell">{formatDateTime(bucket.bucketStart)}</td><td className="number-cell">{formatCount(bucket.viewerCountAvg)}</td><td className="number-cell">{formatCount(bucket.messageCount)}</td><td className="number-cell">{formatCount(bucket.activeChatterCount)}</td><td className="number-cell">{formatCount(bucket.joinCount)} / {formatCount(bucket.partCount)}</td><td>{formatEventCounts(bucket.eventCounts)}</td></tr>)}
            </tbody></table>
          </div>
        )}
      </section>

      {raw == null ? null : (
        <>
          <div className="callout"><div><strong>Privileged captured detail</strong><p>This deployment and account can inspect retained message and chat-presence rows for the session.</p></div><StatusPill tone="accent">Private detail</StatusPill></div>

          <section className="panel">
            <div className="panel-header"><div className="panel-heading"><h2>Captured messages</h2><p>Newest messages first</p></div><StatusPill tone="accent">{raw.messages.length} loaded</StatusPill></div>
            {raw.messages.length === 0 ? <EmptyState title="No messages captured" description="No retained message rows are linked to this stream session." /> : (
              <div className="message-list">
                {raw.messages.map((message) => <article className="message-item" key={message.messageId}>
                  <div className="message-meta"><strong>{message.chatterLogin == null ? "Unknown chatter" : <Link href={`/chatters/${message.chatterLogin}`}>{message.chatterDisplayName ?? message.chatterLogin}</Link>}</strong><span>{formatDateTime(message.sentAt ?? message.receivedAt)}</span><span>{formatStatus(message.source)} · {formatStatus(message.messageType)}</span></div>
                  <p className="message-body">{message.rawText ?? "Message text has been redacted."}</p>
                </article>)}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header"><div className="panel-heading"><h2>Membership signals</h2><p>IRC JOIN/PART observations</p></div><StatusPill>{raw.membershipEvents.length} loaded</StatusPill></div>
            {raw.membershipEvents.length === 0 ? <EmptyState title="No membership signals" description="No retained JOIN/PART rows are linked to this session." /> : (
              <div className="table-scroll" role="region" aria-label="Stream chat membership events" tabIndex={0}><table className="table"><thead><tr><th scope="col">Time</th><th scope="col">Chatter</th><th scope="col">Event</th><th scope="col">Source</th><th scope="col">Confidence</th></tr></thead><tbody>
                {raw.membershipEvents.slice(0, 200).map((event) => <tr key={event.id}><td className="time-cell">{formatDateTime(event.eventAt ?? event.receivedAt)}</td><td>{event.chatterLogin == null ? <span className="muted">Unknown</span> : <Link href={`/chatters/${event.chatterLogin}`}>{event.chatterLogin}</Link>}</td><td><StatusPill tone={event.eventType === "join" ? "success" : "neutral"}>{formatStatus(event.eventType)}</StatusPill></td><td>{formatStatus(event.source)}</td><td className="number-cell">{event.confidence}%</td></tr>)}
              </tbody></table></div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header"><div className="panel-heading"><h2>Presence reconciliation</h2><p>Authorized Get Chatters snapshots</p></div><StatusPill>{raw.presenceSnapshots.length} snapshots</StatusPill></div>
            {raw.presenceSnapshots.length === 0 ? <EmptyState title="No presence snapshots" description="No Get Chatters snapshot is stored for this stream." /> : (
              <div className="table-scroll" role="region" aria-label="Stream presence reconciliation" tabIndex={0}><table className="table table-compact"><thead><tr><th scope="col">Sampled</th><th scope="col">Chatters</th><th scope="col">Pages</th><th scope="col">Source</th><th scope="col">Status</th></tr></thead><tbody>
                {raw.presenceSnapshots.slice(0, 20).map((snapshot) => <tr key={snapshot.id}><td className="time-cell">{formatDateTime(snapshot.sampledAt)}</td><td className="number-cell">{formatCount(snapshot.chatterCount)}</td><td className="number-cell">{formatCount(snapshot.pageCount)}</td><td>{formatStatus(snapshot.source)} · {snapshot.confidence}%</td><td><StatusPill tone={snapshot.requestStatus === "succeeded" ? "success" : "warning"}>{formatStatus(snapshot.requestStatus)}</StatusPill></td></tr>)}
              </tbody></table></div>
            )}
          </section>
        </>
      )}

      <section className="panel">
        <div className="panel-header"><div className="panel-heading"><h2>Channel events</h2><p>EventSub and normalized lifecycle evidence</p></div><StatusPill>{(activity?.events.length ?? 0) + (activity?.raids.length ?? 0)} events</StatusPill></div>
        {activity == null || (activity.events.length === 0 && activity.raids.length === 0) ? <EmptyState title="No channel events" description="No retained channel events are linked to this stream." /> : (
          <div className="table-scroll" role="region" aria-label="Stream channel events" tabIndex={0}><table className="table"><thead><tr><th scope="col">Time</th><th scope="col">Type</th><th scope="col">Source</th><th scope="col">Actor</th></tr></thead><tbody>
            {activity.events.slice(0, 50).map((event) => <tr key={event.id}><td className="time-cell">{formatDateTime(event.occurredAt)}</td><td><StatusPill>{formatStatus(event.eventType)}</StatusPill></td><td>{formatStatus(event.source)}</td><td className="mono-cell">{event.actorUserId ?? "—"}</td></tr>)}
            {activity.raids.slice(0, 25).map((raid) => <tr key={raid.id}><td className="time-cell">{formatDateTime(raid.occurredAt)}</td><td><StatusPill tone="accent">Raid</StatusPill></td><td>{raid.viewerCount == null ? "EventSub" : `${formatCount(raid.viewerCount)} viewers`}</td><td className="mono-cell">{raid.sourceBroadcasterUserId ?? raid.targetBroadcasterUserId ?? "—"}</td></tr>)}
          </tbody></table></div>
        )}
      </section>

      <p className="data-note">Chat tracking covers assigned rooms only. JOIN/PART and Get Chatters observations describe chat-room evidence, not exact stream viewing or duration.</p>
    </>
  );
}

function formatEventCounts(eventCounts: Record<string, number>) {
  const entries = Object.entries(eventCounts);
  return entries.length === 0 ? "—" : entries.map(([eventType, count]) => `${formatStatus(eventType)}: ${formatCount(count)}`).join(", ");
}
