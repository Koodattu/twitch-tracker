import Link from "next/link";
import { getApiData, getAuthenticatedApiInit } from "../../api-client";
import { formatCount, formatDateTime, formatStatus } from "../../format";
import { Avatar, EmptyState, MetricCard, StatusPill } from "../../ui";

type ChatterSummary = {
  login: string;
  publicSummary: boolean;
  detailAvailable: boolean;
  hiddenBySubjectRequest?: boolean;
};

type PrivateChatterProfile = {
  user: {
    twitchUserId: string;
    login: string | null;
    displayName: string | null;
    profileImageUrl: string | null;
  };
  summary: {
    messageCount: number;
    channelCount: number;
    firstMessageAt: string | null;
    lastMessageAt: string | null;
  };
  recentMessages: Array<{
    messageId: string;
    broadcasterLogin: string | null;
    broadcasterDisplayName: string | null;
    twitchStreamId: string | null;
    sentAt: string | null;
    receivedAt: string;
    rawText: string | null;
  }>;
  membershipEvents: Array<{
    id: string;
    eventType: string;
    source: string;
    confidence: number;
    broadcasterLogin: string | null;
    broadcasterDisplayName: string | null;
    twitchStreamId: string | null;
    eventAt: string | null;
    receivedAt: string;
  }>;
  presenceObservations: Array<{
    id: string;
    broadcasterLogin: string | null;
    broadcasterDisplayName: string | null;
    twitchStreamId: string | null;
    observedAt: string;
    source: string;
    confidence: number;
  }>;
};

type ViewerState = {
  user: null | { isAdmin: boolean; login: string | null };
  mode: string;
};

export default async function ChatterPage({ params }: { params: Promise<{ login: string }> }) {
  const { login } = await params;
  const apiInit = await getAuthenticatedApiInit();
  const [summary, profile, viewer] = await Promise.all([
    getApiData<ChatterSummary>(`/api/chatters/${login}`, apiInit),
    getApiData<PrivateChatterProfile>(`/api/private/chatters/${login}`, apiInit),
    getApiData<ViewerState>("/api/me", apiInit)
  ]);
  const name = profile?.user.displayName ?? profile?.user.login ?? summary?.login ?? login;
  const detailLabel = viewer?.user?.isAdmin === true
    ? "Admin view"
    : profile == null
      ? "Limited public view"
      : "Private MVP view";

  return (
    <>
      <section className="page-title page-title-wide">
        <div className="breadcrumbs"><Link href="/">Live streams</Link><span>/</span><span>Observed chatter</span></div>
        <div className="page-heading-row">
          <div className="identity-heading">
            <Avatar name={name} src={profile?.user.profileImageUrl} size="large" />
            <div><span className="eyebrow">Chatter activity</span><h1>{name}</h1></div>
          </div>
          <StatusPill tone={profile == null ? "neutral" : viewer?.user?.isAdmin ? "accent" : "warning"}>{detailLabel}</StatusPill>
        </div>
        <p>Captured chat-room activity associated with this Twitch identity. Presence signals are evidence from chat, never proof of stream viewership.</p>
      </section>

      {summary == null && profile == null ? (
        <div className="callout callout-warning"><div><strong>Chatter data unavailable</strong><p>This identity may not have been observed, may be hidden by request, or the API may be unavailable.</p></div></div>
      ) : null}

      {profile == null ? (
        <section className="panel">
          <div className="panel-header"><div className="panel-heading"><h2>Detailed activity is private</h2><p>Raw timelines are protected by the API.</p></div><StatusPill>Restricted</StatusPill></div>
          <EmptyState
            title={summary?.hiddenBySubjectRequest ? "Hidden by subject request" : "No detailed access"}
            description={summary?.hiddenBySubjectRequest
              ? "This public chatter summary has been hidden through the tracker’s privacy controls."
              : "Sign in to inspect your own captured messages. Administrators can inspect captured data across accounts."}
            action={<Link className="button" href="/me">Go to my data</Link>}
          />
        </section>
      ) : (
        <>
          <section className="stat-row" aria-label="Chatter summary">
            <MetricCard label="Messages captured" value={formatCount(profile.summary.messageCount)} detail={profile.summary.firstMessageAt == null ? "No first message timestamp" : `Since ${formatDateTime(profile.summary.firstMessageAt)}`} />
            <MetricCard label="Channels active" value={formatCount(profile.summary.channelCount)} />
            <MetricCard label="Presence observations" value={formatCount(profile.presenceObservations.length)} detail="Sampled chat-room evidence" />
            <MetricCard
              label="Last message"
              value={profile.summary.lastMessageAt == null ? "—" : "Recorded"}
              detail={profile.summary.lastMessageAt == null ? undefined : formatDateTime(profile.summary.lastMessageAt)}
            />
          </section>

          <section className="panel">
            <div className="panel-header"><div className="panel-heading"><h2>Recent messages</h2><p>Newest captured messages first</p></div><StatusPill tone="accent">{profile.recentMessages.length} loaded</StatusPill></div>
            {profile.recentMessages.length === 0 ? (
              <EmptyState title="No messages captured" description="No retained chat messages are connected to this chatter." />
            ) : (
              <div className="message-list">
                {profile.recentMessages.map((message) => (
                  <article className="message-item" key={message.messageId}>
                    <div className="message-meta">
                      <strong>{message.broadcasterLogin == null ? "Unknown channel" : <Link href={`/channels/${message.broadcasterLogin}`}>{message.broadcasterDisplayName ?? message.broadcasterLogin}</Link>}</strong>
                      <span>{formatDateTime(message.sentAt ?? message.receivedAt)}</span>
                      {message.twitchStreamId == null ? <span>No linked stream</span> : <Link href={`/streams/${message.twitchStreamId}`}>Open stream session</Link>}
                    </div>
                    <p className="message-body">{message.rawText ?? "Message text has been redacted."}</p>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header"><div className="panel-heading"><h2>Presence and membership</h2><p>JOIN/PART and authorized Get Chatters evidence</p></div><StatusPill>{profile.presenceObservations.length + profile.membershipEvents.length} signals</StatusPill></div>
            {profile.presenceObservations.length === 0 && profile.membershipEvents.length === 0 ? (
              <EmptyState title="No presence evidence" description="No retained membership or presence observations are connected to this chatter." />
            ) : (
              <div className="table-scroll" role="region" aria-label="Chatter presence and membership evidence" tabIndex={0}>
                <table className="table">
                  <thead><tr><th scope="col">Time</th><th scope="col">Channel</th><th scope="col">Stream</th><th scope="col">Signal</th><th scope="col">Confidence</th></tr></thead>
                  <tbody>
                    {profile.presenceObservations.slice(0, 80).map((observation) => (
                      <tr key={observation.id}>
                        <td className="time-cell">{formatDateTime(observation.observedAt)}</td>
                        <td>{observation.broadcasterLogin == null ? <span className="muted">Unknown</span> : <Link href={`/channels/${observation.broadcasterLogin}`}>{observation.broadcasterDisplayName ?? observation.broadcasterLogin}</Link>}</td>
                        <td>{observation.twitchStreamId == null ? <span className="muted">Not linked</span> : <Link href={`/streams/${observation.twitchStreamId}`}>Open session</Link>}</td>
                        <td><StatusPill>{formatStatus(observation.source)}</StatusPill></td><td className="number-cell">{observation.confidence}%</td>
                      </tr>
                    ))}
                    {profile.membershipEvents.slice(0, 80).map((event) => (
                      <tr key={event.id}>
                        <td className="time-cell">{formatDateTime(event.eventAt ?? event.receivedAt)}</td>
                        <td>{event.broadcasterLogin == null ? <span className="muted">Unknown</span> : <Link href={`/channels/${event.broadcasterLogin}`}>{event.broadcasterDisplayName ?? event.broadcasterLogin}</Link>}</td>
                        <td>{event.twitchStreamId == null ? <span className="muted">Not linked</span> : <Link href={`/streams/${event.twitchStreamId}`}>Open session</Link>}</td>
                        <td><StatusPill tone={event.eventType === "join" ? "success" : "neutral"}>{formatStatus(event.eventType)} · {formatStatus(event.source)}</StatusPill></td><td className="number-cell">{event.confidence}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="data-note">Detailed rows are bounded and subject to retention, redaction, deletion, and tracking opt-out controls. An absent row does not prove an absent chat visit.</p>
        </>
      )}
    </>
  );
}
