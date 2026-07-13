import Link from "next/link";
import { getApiData, getAuthenticatedApiInit } from "../../api-client";
import { formatCount, formatDateTime, formatStatus } from "../../format";
import { EmptyState, MetricCard, StatusPill } from "../../ui";

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
  const apiInit = await getAuthenticatedApiInit();
  const accounts = await getApiData<InternalBotAccount[]>("/api/internal/bot-accounts", apiInit);
  const activeAccounts = accounts?.filter((account) => account.enabled).length ?? 0;
  const totalCapacity = accounts?.filter((account) => account.enabled).reduce((sum, account) => sum + account.maxJoinedRooms, 0) ?? 0;

  return (
    <>
      <section className="page-title page-title-wide">
        <span className="eyebrow">Admin · Operations</span>
        <div className="page-heading-row"><div><h1>Bot accounts</h1><p>OAuth health, chat-room capacity, and granted scopes for ingestion identities.</p></div><a className="button" href="/api/internal/bot-accounts/oauth/start">Connect bot account</a></div>
      </section>

      {accounts == null ? (
        <section className="panel"><EmptyState title="Bot accounts unavailable" description="Log in with an administrator account, or check the API and database." action={<Link className="button" href="/me">Go to login</Link>} /></section>
      ) : (
        <>
          <section className="stat-row" aria-label="Bot account summary">
            <MetricCard label="Connected accounts" value={formatCount(accounts.length)} />
            <MetricCard label="Enabled accounts" value={formatCount(activeAccounts)} />
            <MetricCard label="Join capacity" value={formatCount(totalCapacity)} detail="Configured rooms across enabled accounts" />
          </section>

          <section className="panel">
            <div className="panel-header"><div className="panel-heading"><h2>Account pool</h2><p>Token values are never exposed in this response</p></div><StatusPill>{accounts.length} accounts</StatusPill></div>
            {accounts.length === 0 ? <EmptyState title="No bot accounts connected" description="Connect a dedicated Twitch bot identity before enabling chat ingestion." action={<a className="button" href="/api/internal/bot-accounts/oauth/start">Connect bot account</a>} /> : (
              <div className="table-scroll" role="region" aria-label="Bot account pool" tabIndex={0}><table className="table"><thead><tr><th scope="col">Account</th><th scope="col">State</th><th scope="col">Capacity</th><th scope="col">Token</th><th scope="col">Scopes</th><th scope="col">Updated</th></tr></thead><tbody>
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <td><div className="cell-stack"><strong>{account.login}</strong><span>{account.twitchUserId ?? "No Twitch user ID"}</span></div></td>
                    <td><div className="cell-stack"><StatusPill tone={account.enabled ? "success" : "neutral"}>{account.enabled ? "Enabled" : "Disabled"}</StatusPill><span>{formatStatus(account.healthStatus)}</span></div></td>
                    <td><div className="cell-stack"><strong>{formatCount(account.maxJoinedRooms)} rooms</strong><span>{formatCount(account.joinRatePer10Seconds)} joins / 10s</span></div></td>
                    <td>{account.token == null ? <StatusPill tone="danger">Missing</StatusPill> : <div className="cell-stack"><StatusPill tone={account.token.refreshStatus === "valid" || account.token.refreshStatus === "refreshed" ? "success" : "warning"}>{formatStatus(account.token.refreshStatus)}</StatusPill><span>{account.token.expiresAt == null ? "No expiry" : `Expires ${formatDateTime(account.token.expiresAt)}`}</span></div>}</td>
                    <td>{account.token == null || account.token.scopes.length === 0 ? <span className="muted">No scopes stored</span> : <div className="scope-list">{account.token.scopes.map((scope) => <StatusPill key={scope}>{scope}</StatusPill>)}</div>}</td>
                    <td className="time-cell">{formatDateTime(account.updatedAt)}</td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
          </section>
          <p className="data-note">Join capacity is an operational limit, not permission to evade Twitch restrictions. Use accounts under operator control and only request scopes required by active features.</p>
        </>
      )}
    </>
  );
}
