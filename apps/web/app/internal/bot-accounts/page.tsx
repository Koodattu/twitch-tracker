import { cookies } from "next/headers";
import { getApiData } from "../../api-client";

type InternalBotAccount = {
  id: string;
  twitchUserId: string | null;
  login: string;
  enabled: boolean;
  maxJoinedRooms: number;
  joinRatePer10Seconds: number;
  priority: number;
  healthStatus: string;
  updatedAt: string;
  token: null | {
    scopes: string[];
    expiresAt: string | null;
    lastValidatedAt: string | null;
    refreshStatus: string;
    updatedAt: string;
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
  };
};

export default async function BotAccountsPage() {
  const cookieHeader = cookies().toString();
  const apiInit: RequestInit = cookieHeader === ""
    ? { cache: "no-store" }
    : { cache: "no-store", headers: { Cookie: cookieHeader } };
  const accounts = await getApiData<InternalBotAccount[]>("/api/internal/bot-accounts", apiInit);

  return (
    <>
      <section className="page-title">
        <h1>Bot Accounts</h1>
        <p>OAuth status, join capacity, and token health for ingestion bots.</p>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Accounts</h2>
          <a className="button" href="/api/internal/bot-accounts/oauth/start">Connect bot</a>
        </div>
        {accounts == null ? (
          <p className="muted padded">Bot account status is not available.</p>
        ) : accounts.length === 0 ? (
          <p className="muted padded">No bot accounts connected.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Login</th>
                <th>Enabled</th>
                <th>Capacity</th>
                <th>Token</th>
                <th>Scopes</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr key={account.id}>
                  <td>
                    <strong>{account.login}</strong>
                    <div className="muted">{account.twitchUserId ?? "No Twitch user ID"}</div>
                  </td>
                  <td>{account.enabled ? "Yes" : "No"}</td>
                  <td>
                    {account.maxJoinedRooms} rooms
                    <div className="muted">{account.joinRatePer10Seconds} joins / 10s</div>
                  </td>
                  <td>
                    {account.token == null ? (
                      "Missing"
                    ) : (
                      <>
                        <span className="badge">{account.token.refreshStatus}</span>
                        <div className="muted">{account.token.expiresAt == null ? "No expiry" : account.token.expiresAt}</div>
                      </>
                    )}
                  </td>
                  <td>
                    {account.token == null || account.token.scopes.length === 0 ? (
                      <span className="muted">No scopes stored</span>
                    ) : (
                      <div className="scope-list">
                        {account.token.scopes.map((scope) => (
                          <span className="badge" key={scope}>{scope}</span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>{new Date(account.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
