import { cookies } from "next/headers";
import { getApiData } from "../../api-client";

type ChatterSummary = {
  login: string;
  publicSummary: boolean;
  detailAvailable: boolean;
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

export default async function ChatterPage({ params }: { params: Promise<{ login: string }> }) {
  const { login } = await params;
  const cookieHeader = cookies().toString();
  const privateApiInit: RequestInit = cookieHeader === ""
    ? { cache: "no-store" }
    : { cache: "no-store", headers: { Cookie: cookieHeader } };
  const summary = await getApiData<ChatterSummary>(`/api/chatters/${login}`);
  const profile = await getApiData<PrivateChatterProfile>(`/api/private/chatters/${login}`, privateApiInit);

  return (
    <>
      <section className="page-title">
        <h1>{profile?.user.displayName ?? summary?.login ?? login}</h1>
        <p>{summary?.detailAvailable ? "Private MVP profile is available in this deployment mode." : "Public chatter summary."}</p>
      </section>

      <section className="stat-row">
        <div className="stat">
          <span className="muted">Messages</span>
          <strong>{profile?.summary.messageCount ?? 0}</strong>
        </div>
        <div className="stat">
          <span className="muted">Channels</span>
          <strong>{profile?.summary.channelCount ?? 0}</strong>
        </div>
        <div className="stat">
          <span className="muted">Presence</span>
          <strong>{profile?.presenceObservations.length ?? 0}</strong>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Chatter Summary</h2>
          <span className="badge">{summary?.detailAvailable ? "private detail enabled" : "limited public view"}</span>
        </div>
        <table className="table">
          <tbody>
            <tr>
              <th>Login</th>
              <td>{summary?.login ?? login}</td>
            </tr>
            <tr>
              <th>Raw timeline</th>
              <td>{summary?.detailAvailable ? "Available through private endpoints" : "Requires own-data login"}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Recent Messages</h2>
          <span className="badge">{profile?.recentMessages.length ?? 0} shown</span>
        </div>
        {profile == null ? (
          <p className="muted padded">Detailed chatter data is not available.</p>
        ) : profile.recentMessages.length === 0 ? (
          <p className="muted padded">No messages have been captured for this chatter.</p>
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
              {profile.recentMessages.map((message) => (
                <tr key={message.messageId}>
                  <td>{new Date(message.sentAt ?? message.receivedAt).toLocaleString()}</td>
                  <td>{message.broadcasterLogin == null ? "-" : <a href={`/channels/${message.broadcasterLogin}`}>{message.broadcasterDisplayName ?? message.broadcasterLogin}</a>}</td>
                  <td className="message-cell">{message.rawText ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Presence And Membership</h2>
          <span className="badge">{profile?.membershipEvents.length ?? 0} JOIN/PART</span>
        </div>
        {profile == null ? (
          <p className="muted padded">Presence detail is not available.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Channel</th>
                <th>Signal</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {profile.presenceObservations.slice(0, 80).map((observation) => (
                <tr key={observation.id}>
                  <td>{new Date(observation.observedAt).toLocaleString()}</td>
                  <td>{observation.broadcasterLogin == null ? "-" : observation.broadcasterDisplayName ?? observation.broadcasterLogin}</td>
                  <td>{observation.source}</td>
                  <td>{observation.confidence}%</td>
                </tr>
              ))}
              {profile.membershipEvents.slice(0, 80).map((event) => (
                <tr key={event.id}>
                  <td>{new Date(event.eventAt ?? event.receivedAt).toLocaleString()}</td>
                  <td>{event.broadcasterLogin == null ? "-" : event.broadcasterDisplayName ?? event.broadcasterLogin}</td>
                  <td>{event.eventType} / {event.source}</td>
                  <td>{event.confidence}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
