import Link from "next/link";
import type { Metadata } from "next";
import { getApiData, getAuthenticatedApiInit } from "../../api-client";
import { formatCount, formatDateTime, formatStatus } from "../../format";
import { EmptyState, MetricCard, StatusPill } from "../../ui";

export const metadata: Metadata = { title: "Bot accounts" };

type InternalBotAccount = {
  id: string;
  twitchUserId: string | null;
  login: string;
  enabled: boolean;
  maxJoinedRooms: number;
  effectiveCapacity: number;
  joinRatePer10Seconds: number;
  priority: number;
  healthStatus: string;
  updatedAt: string;
  blockedChannels: Array<{
    broadcasterUserId: string;
    broadcasterLogin: string | null;
    broadcasterDisplayName: string | null;
    reason: string | null;
    scope: "account" | "global" | null;
    detectedAt: string;
  }>;
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
  const configuredCapacity = accounts?.filter((account) => account.enabled).reduce((sum, account) => sum + account.maxJoinedRooms, 0) ?? 0;
  const effectiveCapacity = accounts?.reduce((sum, account) => sum + account.effectiveCapacity, 0) ?? 0;
  const blockedChannels = accounts?.flatMap((account) => account.blockedChannels.map((channel) => ({
    ...channel,
    botAccountId: account.id,
    botLogin: account.login
  }))) ?? [];
  const blocksByChannel = new Map<string, (typeof blockedChannels)[number] & { blocks: typeof blockedChannels }>();
  for (const block of blockedChannels) {
    const group = blocksByChannel.get(block.broadcasterUserId) ?? { ...block, blocks: [] };
    group.blocks.push(block);
    if (block.detectedAt > group.detectedAt) group.detectedAt = block.detectedAt;
    blocksByChannel.set(block.broadcasterUserId, group);
  }
  const channelGroups = Array.from(blocksByChannel.values()).sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
  for (const group of channelGroups) group.blocks.sort((a, b) => a.botLogin.localeCompare(b.botLogin));

  return (
    <>
      <section className="page-title page-title-wide">
        <span className="eyebrow">Admin · Operations</span>
        <div className="page-heading-row"><div><h1>Bot accounts</h1><p>Twitch will ask you to authorize every connection. Confirm that Twitch shows the dedicated bot account before approving.</p></div><a className="button" href="/api/internal/bot-accounts/oauth/start">Connect bot account</a></div>
      </section>

      {accounts == null ? (
        <section className="panel"><EmptyState title="Bot accounts unavailable" description="Log in with an administrator account, or check the API and database." action={<Link className="button" href="/me">Go to login</Link>} /></section>
      ) : (
        <>
          <section className="stat-row" aria-label="Bot account summary">
            <MetricCard label="Connected accounts" value={formatCount(accounts.length)} />
            <MetricCard label="Enabled accounts" value={formatCount(activeAccounts)} />
            <MetricCard label="Join capacity" value={formatCount(effectiveCapacity)} detail={`${formatCount(configuredCapacity)} rooms configured`} />
            <MetricCard label="Blocked channels" value={formatCount(channelGroups.length)} detail={`${formatCount(blockedChannels.length)} bot and channel pairs`} />
          </section>

          <section className="panel">
            <div className="panel-header"><div className="panel-heading"><h2>Account pool</h2><p>Token values are never exposed in this response</p></div><StatusPill>{accounts.length} accounts</StatusPill></div>
            {accounts.length === 0 ? <EmptyState title="No bot accounts connected" description="Connect a dedicated Twitch bot identity before enabling chat ingestion." action={<a className="button" href="/api/internal/bot-accounts/oauth/start">Connect bot account</a>} /> : (
              <div className="table-scroll" role="region" aria-label="Bot account pool" tabIndex={0}><table className="table"><thead><tr><th scope="col">Account</th><th scope="col">State</th><th scope="col">Capacity</th><th scope="col">Blocked</th><th scope="col">Token</th><th scope="col">Scopes</th><th scope="col">Updated</th></tr></thead><tbody>
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <td><div className="cell-stack"><strong>{account.login}</strong><span>{account.twitchUserId ?? "No Twitch user ID"}</span></div></td>
                    <td><div className="cell-stack"><StatusPill tone={account.enabled ? "success" : "neutral"}>{account.enabled ? "Enabled" : "Disabled"}</StatusPill><span>{formatStatus(account.healthStatus)}</span></div></td>
                    <td><div className="cell-stack"><strong>{formatCount(account.effectiveCapacity)} / {formatCount(account.maxJoinedRooms)} rooms</strong><span>Effective / configured · {formatCount(account.joinRatePer10Seconds)} joins / 10s</span></div></td>
                    <td>{account.blockedChannels.length === 0 ? <span className="muted">None</span> : <StatusPill tone="danger">{formatCount(account.blockedChannels.length)}</StatusPill>}</td>
                    <td>{account.token == null ? <StatusPill tone="danger">Missing</StatusPill> : <div className="cell-stack"><StatusPill tone={account.token.refreshStatus === "valid" || account.token.refreshStatus === "refreshed" ? "success" : "warning"}>{formatStatus(account.token.refreshStatus)}</StatusPill><span>{account.token.expiresAt == null ? "No expiry" : `Expires ${formatDateTime(account.token.expiresAt)}`}</span></div>}</td>
                    <td>{account.token == null || account.token.scopes.length === 0 ? <span className="muted">No scopes stored</span> : <div className="scope-list">{account.token.scopes.map((scope) => <StatusPill key={scope}>{scope}</StatusPill>)}</div>}</td>
                    <td className="time-cell">{formatDateTime(account.updatedAt)}</td>
                  </tr>
                ))}
              </tbody></table></div>
            )}
          </section>

          <section className="panel">
            <div className="panel-header"><div className="panel-heading"><h2>Blocked channels</h2><p>Grouped by channel, most recently detected first. Expand for restriction details and retry options.</p></div><StatusPill tone={channelGroups.length === 0 ? "success" : "danger"}>{formatCount(channelGroups.length)} channels</StatusPill></div>
            {blockedChannels.length === 0 ? <EmptyState title="No blocked channels" description="Twitch has not reported a permanent channel restriction for any connected bot." /> : (
              <div className="blocked-channel-list">
                {channelGroups.map((channel) => (
                  <details className="blocked-channel-group" key={channel.broadcasterUserId}>
                    <summary>
                      <span className="cell-stack blocked-channel-name">
                        <strong>{channel.broadcasterDisplayName ?? channel.broadcasterLogin ?? channel.broadcasterUserId}</strong>
                        <span>{channel.broadcasterLogin == null ? channel.broadcasterUserId : `@${channel.broadcasterLogin}`}</span>
                      </span>
                      <span className="blocked-channel-bots" aria-label="Affected bots">
                        {channel.blocks.map((block) => <StatusPill key={block.botAccountId} tone="warning">{block.botLogin}</StatusPill>)}
                        {channel.blocks.some((block) => block.scope === "global") ? <StatusPill tone="danger">All bots restricted</StatusPill> : null}
                      </span>
                      <span className="cell-stack blocked-channel-detected"><span>Last detected</span><span>{formatDateTime(channel.detectedAt)}</span></span>
                    </summary>
                    {channel.broadcasterLogin == null ? null : <div className="blocked-channel-link"><Link className="text-link" href={`/channels/${encodeURIComponent(channel.broadcasterLogin)}`}>View channel →</Link></div>}
                    <div className="table-scroll" role="region" aria-label={`Restrictions for ${channel.broadcasterDisplayName ?? channel.broadcasterLogin ?? channel.broadcasterUserId}`} tabIndex={0}>
                      <table className="table"><thead><tr><th scope="col">Bot</th><th scope="col">Scope</th><th scope="col">Twitch response</th><th scope="col">Last detected</th><th scope="col">Action</th></tr></thead><tbody>
                        {channel.blocks.map((block) => (
                          <tr key={block.botAccountId}>
                            <td><strong>{block.botLogin}</strong></td>
                            <td><StatusPill tone={block.scope === "global" ? "danger" : "warning"}>{block.scope === "global" ? "All bots" : "This bot"}</StatusPill></td>
                            <td>{block.reason ?? "Permanent IRC restriction"}</td>
                            <td className="time-cell">{formatDateTime(block.detectedAt)}</td>
                            <td><form action={`/api/internal/bot-accounts/${encodeURIComponent(block.botAccountId)}/blocked-channels/${encodeURIComponent(block.broadcasterUserId)}/retry`} method="post"><button className="button button-secondary" type="submit" aria-label={`Retry ${block.botLogin} in ${channel.broadcasterLogin ?? channel.broadcasterUserId}`}>Retry</button></form></td>
                          </tr>
                        ))}
                      </tbody></table>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>
          <p className="data-note">Retry only after confirming that Twitch or the broadcaster lifted the restriction. Join capacity is an operational limit, not permission to evade Twitch restrictions.</p>
        </>
      )}
    </>
  );
}
