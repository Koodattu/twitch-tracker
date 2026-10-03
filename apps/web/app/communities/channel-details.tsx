"use client";

import { useState } from "react";
import Link from "next/link";
import { formatCount } from "../format";
import { Avatar } from "../ui";
import { channelName, communityColor, participants, type MapConnection, type MapNode } from "./map-data";
import { summarizeCommunityCategories } from "./map-categories";

export function ChannelDetails({ node, connections, community, onSelect, onClose }: {
  node: MapNode; connections: MapConnection[]; community: MapNode[];
  onSelect: (node: MapNode) => void; onClose: () => void;
}) {
  const [sort, setSort] = useState("shared");
  const [limit, setLimit] = useState(10);
  const [share, setShare] = useState<{ url: string; copied: boolean } | null>(null);
  const categories = summarizeCommunityCategories(community);
  const ordered = [...connections].sort((a, b) => (sort === "name" ? channelName(a.node).localeCompare(channelName(b.node))
    : sort === "similarity" ? b.score - a.score || b.shared - a.shared : b.shared - a.shared || b.score - a.score)
    || channelName(a.node).localeCompare(channelName(b.node)));
  const copy = async () => {
    const url = window.location.href;
    try { await navigator.clipboard.writeText(url); setShare({ url, copied: true }); }
    catch { setShare({ url, copied: false }); }
  };
  return <section className="community-details community-glass" aria-label="Selected channel">
    <div className="community-detail-header">
      <Avatar name={channelName(node)} src={node.profileImageUrl} size="small" />
      <div><h2>{channelName(node)}</h2>{node.login != null && <Link href={`/channels/${encodeURIComponent(node.login)}`}>View channel profile</Link>}</div>
      <button className="community-icon-button" aria-label="Close channel details" onClick={onClose}>×</button>
    </div>
    <p className="community-detail-period">In this 30-day map</p>
    <dl className="community-detail-stats"><div><dt>People in chat</dt><dd>{formatCount(participants(node))}</dd></div><div><dt>Connected channels</dt><dd>{formatCount(connections.length)}</dd></div></dl>
    <section className="community-connections" aria-labelledby="community-connections-title">
      <h3 id="community-connections-title">Connected channels</h3>
      {connections.length === 0 ? <p>No other channel meets the shared-people threshold for a connection. This does not mean the channel has no community.</p> : <>
        <div className="community-connection-sort"><label htmlFor="community-connection-sort">Sort by</label><select id="community-connection-sort" value={sort} onChange={event => { setSort(event.target.value); setLimit(10); }}>
          <option value="shared">Shared people</option><option value="similarity">Connection strength</option><option value="name">Channel name</option>
        </select></div>
        <div className="community-list-heading"><span>Channel</span><span>Shared people</span></div>
        <ul className="community-channel-list community-connection-list">{ordered.slice(0, limit).map(edge => <li key={edge.node.id}><button onClick={() => onSelect(edge.node)}>
          <span className="community-color" style={{ background: communityColor(edge.node.community) }} /><span>{channelName(edge.node)}</span>
          <span className="community-overlap"><strong>{formatCount(edge.shared)}</strong><small>{edge.shared * 100 < participants(node) ? "<1" : Math.round(edge.shared / participants(node) * 100)}% of this chat</small></span>
        </button></li>)}</ul>
        {limit < ordered.length && <button className="community-text-button" onClick={() => setLimit(limit + 10)}>Show more connections ({ordered.length - limit} remaining)</button>}
        <details className="community-connection-explanation"><summary>How to read these connections</summary>
          <p>Percentages show how much of this channel’s observed chat also appears in each channel. Connection strength balances shared people, audience size and chat evidence.</p>
        </details>
      </>}
    </section>
    {node.community != null && <details className="community-category-summary"><summary><span className="community-color" style={{ background: communityColor(node.community) }} />Community details · {community.length} channels</summary>
      <p>Grouped by shared chat participation, not by game.</p>
      {categories == null ? <p>There is not enough recorded category information to describe this community.</p> : <>
        <h3>{categories.title}</h3>
        <ul>{categories.categories.map(category => <li key={category.id}><span>{category.name}</span><span>{category.channels} / {categories.known} channels</span></li>)}</ul>
        {categories.mixed > 0 && <p>{categories.mixed} channels split their time across categories.</p>}
        <p>Based on recorded streaming time. Category information covers {categories.known} of {categories.total} channels; each channel counts once.</p>
      </>}
    </details>}
    <div className="community-share"><button className="community-text-button" onClick={copy}>Copy channel map link</button><p>Reopens this channel in the latest map. Chatter highlights are not shared.</p>
      {share != null && <div role="status">{share.copied ? "Map link copied." : <label>Copy this map link<input className="search-input" readOnly value={share.url} onFocus={event => event.currentTarget.select()} /></label>}</div>}
    </div>
  </section>;
}
