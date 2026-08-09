import Link from "next/link";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getApiBaseUrl, getApiData, getAuthenticatedApiInit } from "../api-client";
import { ConfirmSubmitButton } from "../confirm-submit-button";
import { formatCount, formatDateTime, formatStatus } from "../format";
import { Avatar, EmptyState, MetricCard, StatusPill } from "../ui";

export const metadata: Metadata = { title: "My activity" };

type Me = {
  user: null | {
    appUserId: string;
    twitchUserId: string;
    login: string;
    displayName: string | null;
    profileImageUrl: string | null;
    isAdmin: boolean;
  };
  mode: string;
  authConfigured: boolean;
};

type OwnData = {
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
    receivedAt: string;
    rawText: string | null;
  }>;
};

type PrivacyData = {
  state: {
    publicProfileHidden: boolean;
    trackingOptedOut: boolean;
    rawDataRedactedAt: string | null;
    dataDeletedAt: string | null;
    latestRequestId: string | null;
  };
  requests: Array<{
    id: string;
    requestType: string;
    status: string;
    requestedAt: string;
    resolvedAt: string | null;
  }>;
};

async function createPrivacyRequest(formData: FormData) {
  "use server";

  const requestType = formData.get("requestType");
  if (typeof requestType !== "string") {
    redirect("/me?privacy=failed");
  }

  const apiInit = await getAuthenticatedApiInit();
  const headers = new Headers(apiInit.headers);
  headers.set("Content-Type", "application/json");
  let succeeded = false;
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/me/privacy/requests`, {
      ...apiInit,
      method: "POST",
      headers,
      body: JSON.stringify({ requestType }),
      signal: AbortSignal.timeout(10_000)
    });
    succeeded = response.ok;
  } catch {
    succeeded = false;
  }
  redirect(succeeded ? "/me?privacy=received" : "/me?privacy=failed");
}

export default async function MePage({ searchParams }: { searchParams: Promise<{ auth?: string; privacy?: string }> }) {
  const query = await searchParams;
  const apiInit = await getAuthenticatedApiInit();
  const me = await getApiData<Me>("/api/me", apiInit);
  const [ownData, privacyData] = me?.user == null
    ? [null, null]
    : await Promise.all([
        getApiData<OwnData>("/api/me/data", apiInit),
        getApiData<PrivacyData>("/api/me/privacy", apiInit)
      ]);

  return (
    <>
      <section className="page-title">
        <span className="eyebrow">Your Twitch identity</span>
        <h1>{me?.user == null ? "See what we’ve captured" : "Your activity"}</h1>
        <p>Sign in with Twitch to access messages associated with your immutable Twitch user ID. Your Twitch token never reaches browser JavaScript.</p>
      </section>

      <AuthNotice status={query.auth} />
      <PrivacyNotice status={query.privacy} />

      {me == null ? (
        <section className="panel"><EmptyState title="Account service unavailable" description="Your account and privacy settings could not be loaded. Please try again shortly." /></section>
      ) : me.user == null ? (
        <section className="login-panel">
          <div className="login-copy">
            <StatusPill tone="accent">Own data view</StatusPill>
            <h2>One Twitch sign-in, only your data</h2>
            <p>The tracker uses Twitch to confirm who you are, then matches that identity to retained chat activity. No email or password is requested.</p>
            {me?.authConfigured === true ? (
              <a className="button" href="/api/auth/twitch/start">Continue with Twitch</a>
            ) : (
              <div className="callout callout-warning"><div><strong>Twitch login is unavailable</strong><p>Sign-in is temporarily unavailable. Please try again later.</p></div></div>
            )}
          </div>
          <aside className="login-aside">
            <span className="eyebrow">What you can inspect</span>
            <ul><li>Your retained messages</li><li>The channel and stream context</li><li>Your privacy and deletion requests</li></ul>
          </aside>
        </section>
      ) : (
        <>
          <section className="panel">
            <div className="profile-card">
              <Avatar name={me.user.displayName ?? me.user.login} src={me.user.profileImageUrl} size="large" />
              <div className="profile-copy">
                <div className="page-actions"><StatusPill tone="success">Connected</StatusPill>{me.user.isAdmin ? <StatusPill tone="accent">Administrator</StatusPill> : null}</div>
                <h2>{me.user.displayName ?? me.user.login}</h2>
                <p>@{me.user.login}{me.user.isAdmin ? ` · ${formatStatus(me.mode)} mode` : ""}</p>
              </div>
              <div className="profile-actions">
                {me.user.isAdmin ? <Link className="button" href="/internal/messages">Open message archive</Link> : null}
                <form action="/api/auth/logout" method="post"><button className="button button-secondary" type="submit">Log out</button></form>
              </div>
            </div>
          </section>

          <section className="stat-row" aria-label="Own activity summary">
            <MetricCard label="Messages captured" value={formatCount(ownData?.summary.messageCount)} detail={ownData?.summary.firstMessageAt == null ? "No retained first message" : `Since ${formatDateTime(ownData.summary.firstMessageAt)}`} />
            <MetricCard label="Channels active" value={formatCount(ownData?.summary.channelCount)} />
            <MetricCard
              label="Last message"
              value={ownData?.summary.lastMessageAt == null ? "—" : "Recorded"}
              detail={ownData?.summary.lastMessageAt == null ? undefined : formatDateTime(ownData.summary.lastMessageAt)}
            />
          </section>

          <section className="panel">
            <div className="panel-header"><div className="panel-heading"><h2>Your recent messages</h2><p>Newest retained messages first</p></div><StatusPill tone={ownData == null ? "danger" : "accent"}>{ownData == null ? "Unavailable" : `${ownData.recentMessages.length} loaded`}</StatusPill></div>
            {ownData == null ? (
              <EmptyState title="Activity unavailable" description="Your session is valid, but activity data could not be loaded." />
            ) : ownData.recentMessages.length === 0 ? (
              <EmptyState title="No messages connected yet" description="The tracker has no retained chat messages associated with this Twitch identity." />
            ) : (
              <div className="message-list">
                {ownData.recentMessages.map((message) => (
                  <article className="message-item" key={message.messageId}>
                    <div className="message-meta">
                      <strong>{message.broadcasterLogin == null ? "Unknown channel" : <Link href={`/channels/${message.broadcasterLogin}`}>{message.broadcasterDisplayName ?? message.broadcasterLogin}</Link>}</strong>
                      <span>{formatDateTime(message.receivedAt)}</span>
                      {message.twitchStreamId == null ? <span>No linked stream</span> : <Link href={`/streams/${message.twitchStreamId}`}>Open stream session</Link>}
                    </div>
                    <p className="message-body">{message.rawText ?? "Message text has been redacted."}</p>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header">
              <div className="panel-heading"><h2>Privacy controls</h2><p>Manage future tracking and retained subject data</p></div>
              <StatusPill tone={privacyData == null ? "danger" : privacyData.state.trackingOptedOut ? "warning" : "success"}>{privacyData == null ? "Unavailable" : privacyData.state.trackingOptedOut ? "Tracking opted out" : "Tracking allowed"}</StatusPill>
            </div>
            {privacyData == null ? (
              <EmptyState title="Privacy controls unavailable" description="Privacy state could not be loaded for this session." />
            ) : (
              <>
                <div className="table-scroll" role="region" aria-label="Current privacy settings" tabIndex={0}>
                  <table className="table table-compact">
                    <tbody>
                      <tr><th scope="row">Public chatter summary</th><td>{privacyData.state.publicProfileHidden ? "Hidden by request" : "Visible when public summaries are enabled"}</td></tr>
                      <tr><th scope="row">Future broadcaster tracking</th><td>{privacyData.state.trackingOptedOut ? "Opted out" : "Allowed"}</td></tr>
                      <tr><th scope="row">Raw data redaction</th><td>{privacyData.state.rawDataRedactedAt == null ? "No deletion completed" : formatDateTime(privacyData.state.rawDataRedactedAt)}</td></tr>
                    </tbody>
                  </table>
                </div>
                <div className="action-row">
                  <form action={createPrivacyRequest}><input type="hidden" name="requestType" value="public_profile_opt_out" /><ConfirmSubmitButton className="button button-secondary" pendingLabel="Hiding…" disabled={privacyData.state.publicProfileHidden}>Hide public summary</ConfirmSubmitButton></form>
                  <form action={createPrivacyRequest}><input type="hidden" name="requestType" value="tracking_opt_out" /><ConfirmSubmitButton className="button button-secondary" pendingLabel="Submitting…" disabled={privacyData.state.trackingOptedOut}>Opt out of tracking</ConfirmSubmitButton></form>
                  <form action={createPrivacyRequest}><input type="hidden" name="requestType" value="data_deletion" /><ConfirmSubmitButton className="button button-danger" pendingLabel="Requesting deletion…" disabled={privacyData.state.dataDeletedAt != null || privacyData.requests.some((request) => request.requestType === "data_deletion" && request.status === "pending")} message="Request deletion of retained subject data? This request cannot be undone once completed.">Request data deletion</ConfirmSubmitButton></form>
                </div>
              </>
            )}
          </section>

          <section className="panel">
            <div className="panel-header"><div className="panel-heading"><h2>Privacy requests</h2><p>Your latest requests and their status</p></div></div>
            {privacyData == null ? (
              <EmptyState title="Privacy requests unavailable" description="Request history could not be loaded for this session." />
            ) : privacyData.requests.length === 0 ? (
              <EmptyState title="No privacy requests" description="Requests you make will appear here." />
            ) : (
              <div className="table-scroll" role="region" aria-label="Privacy request history" tabIndex={0}>
                <table className="table table-compact">
                  <thead><tr><th scope="col">Type</th><th scope="col">Status</th><th scope="col">Requested</th><th scope="col">Resolved</th></tr></thead>
                  <tbody>{privacyData.requests.map((request) => <tr key={request.id}><td>{formatStatus(request.requestType)}</td><td><StatusPill tone={request.status === "completed" ? "success" : "warning"}>{formatStatus(request.status)}</StatusPill></td><td className="time-cell">{formatDateTime(request.requestedAt)}</td><td className="time-cell">{formatDateTime(request.resolvedAt)}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </section>

          {me.user.isAdmin ? <p className="data-note">Admin access is enforced by the API in every deployment mode. Twitch user ID: {me.user.twitchUserId}.</p> : null}
        </>
      )}
    </>
  );
}

function AuthNotice({ status }: { status: string | undefined }) {
  if (status == null) return null;
  if (status === "cancelled") return <div className="callout" role="status"><div><strong>Twitch login cancelled</strong><p>No account was connected.</p></div></div>;
  if (status === "not_configured") return <div className="callout callout-warning" role="status"><div><strong>Twitch login is unavailable</strong><p>Sign-in is temporarily unavailable. Please try again later.</p></div></div>;
  return <div className="callout callout-danger" role="alert"><div><strong>Twitch login failed</strong><p>The login could not be verified. Please start again from this page.</p></div></div>;
}

function PrivacyNotice({ status }: { status: string | undefined }) {
  if (status === "received") return <div className="callout" role="status" aria-live="polite"><div><strong>Privacy request received</strong><p>Your request was recorded. Its status is shown below.</p></div></div>;
  if (status === "failed") return <div className="callout callout-danger" role="alert"><div><strong>Privacy request failed</strong><p>The request was not recorded. Please try again.</p></div></div>;
  return null;
}
