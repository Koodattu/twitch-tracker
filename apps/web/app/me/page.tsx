import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { getApiBaseUrl, getApiData } from "../api-client";

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
    return;
  }

  const cookieHeader = cookies().toString();
  await fetch(`${getApiBaseUrl()}/api/me/privacy/requests`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader
    },
    body: JSON.stringify({ requestType })
  });
  revalidatePath("/me");
}

export default async function MePage() {
  const cookieHeader = cookies().toString();
  const apiInit: RequestInit = cookieHeader === ""
    ? { cache: "no-store" }
    : { cache: "no-store", headers: { Cookie: cookieHeader } };
  const me = await getApiData<Me>("/api/me", apiInit);
  const ownData = me?.user == null
    ? null
    : await getApiData<OwnData>("/api/me/data", apiInit);
  const privacyData = me?.user == null
    ? null
    : await getApiData<PrivacyData>("/api/me/privacy", apiInit);

  return (
    <>
      <section className="page-title">
        <h1>Own Data</h1>
        <p>Your Twitch login controls access to detailed timelines connected to your account.</p>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Session</h2>
          {me?.user == null ? (
            <a className="button" href="/api/auth/twitch/start">Log in with Twitch</a>
          ) : (
            <form action="/api/auth/logout" method="post">
              <button className="button" type="submit">Log out</button>
            </form>
          )}
        </div>
        <table className="table">
          <tbody>
            <tr>
              <th>Status</th>
              <td>{me?.user == null ? "Not logged in" : `Logged in as ${me.user.displayName ?? me.user.login}`}</td>
            </tr>
            <tr>
              <th>Mode</th>
              <td>{me?.mode ?? "unknown"}</td>
            </tr>
            {me?.user != null ? (
              <>
                <tr>
                  <th>Twitch user ID</th>
                  <td>{me.user.twitchUserId}</td>
                </tr>
                <tr>
                  <th>Admin</th>
                  <td>{me.user.isAdmin ? "Yes" : "No"}</td>
                </tr>
              </>
            ) : null}
          </tbody>
        </table>
      </section>

      {ownData == null ? null : (
        <>
          <section className="panel">
            <div className="panel-header">
              <h2>Tracked Activity</h2>
            </div>
            <table className="table">
              <tbody>
                <tr>
                  <th>Messages</th>
                  <td>{ownData.summary.messageCount}</td>
                </tr>
                <tr>
                  <th>Channels</th>
                  <td>{ownData.summary.channelCount}</td>
                </tr>
                <tr>
                  <th>First seen</th>
                  <td>{ownData.summary.firstMessageAt ?? "No messages stored yet"}</td>
                </tr>
                <tr>
                  <th>Last seen</th>
                  <td>{ownData.summary.lastMessageAt ?? "No messages stored yet"}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>Privacy Controls</h2>
              <span className="badge">{privacyData?.state.trackingOptedOut ? "tracking opted out" : "tracking allowed"}</span>
            </div>
            <table className="table">
              <tbody>
                <tr>
                  <th>Public profile</th>
                  <td>{privacyData?.state.publicProfileHidden ? "Hidden by request" : "Visible when public summaries are enabled"}</td>
                </tr>
                <tr>
                  <th>Tracking opt-out</th>
                  <td>{privacyData?.state.trackingOptedOut ? "Enabled" : "Not enabled"}</td>
                </tr>
                <tr>
                  <th>Raw data redacted</th>
                  <td>{privacyData?.state.rawDataRedactedAt ?? "No deletion completed"}</td>
                </tr>
              </tbody>
            </table>
            <div className="action-row">
              <form action={createPrivacyRequest}>
                <input type="hidden" name="requestType" value="public_profile_opt_out" />
                <button className="button" type="submit">Hide public profile</button>
              </form>
              <form action={createPrivacyRequest}>
                <input type="hidden" name="requestType" value="tracking_opt_out" />
                <button className="button" type="submit">Opt out of tracking</button>
              </form>
              <form action={createPrivacyRequest}>
                <input type="hidden" name="requestType" value="data_deletion" />
                <button className="button button-secondary" type="submit">Request data deletion</button>
              </form>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>Privacy Requests</h2>
            </div>
            {privacyData == null || privacyData.requests.length === 0 ? (
              <p className="muted padded">No privacy requests yet.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Requested</th>
                    <th>Resolved</th>
                  </tr>
                </thead>
                <tbody>
                  {privacyData.requests.map((request) => (
                    <tr key={request.id}>
                      <td>{formatRequestType(request.requestType)}</td>
                      <td>{request.status}</td>
                      <td>{request.requestedAt}</td>
                      <td>{request.resolvedAt ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="panel">
            <div className="panel-header">
              <h2>Recent Messages</h2>
            </div>
            {ownData.recentMessages.length === 0 ? (
              <p className="muted">No stored chat messages are connected to this account yet.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Channel</th>
                    <th>Message</th>
                  </tr>
                </thead>
                <tbody>
                  {ownData.recentMessages.map((message) => (
                    <tr key={message.messageId}>
                      <td>{message.receivedAt}</td>
                      <td>{message.broadcasterDisplayName ?? message.broadcasterLogin ?? "Unknown"}</td>
                      <td>{message.rawText ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </>
  );
}

function formatRequestType(requestType: string) {
  switch (requestType) {
    case "public_profile_opt_out":
      return "Public profile opt-out";
    case "tracking_opt_out":
      return "Tracking opt-out";
    case "data_deletion":
      return "Data deletion";
    default:
      return requestType;
  }
}
