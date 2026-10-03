"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CommunityChatterActivity, CommunityMap } from "@twitch-tracker/shared";
import { formatCount } from "../format";
import { channelName, communityColor, type MapNode } from "./map-data";

export function ChatterLookup({ map, result, onResult, onSelect }: {
  map: CommunityMap; result: CommunityChatterActivity | null;
  onResult: (result: CommunityChatterActivity | null) => void; onSelect: (node: MapNode) => void;
}) {
  const [login, setLogin] = useState(result?.login ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const search = async (event: FormEvent) => {
    event.preventDefault();
    const query = login.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(query)) { setError("Enter a Twitch username using letters, numbers or underscores."); return; }
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true); setError(null); onResult(null);
    try {
      const response = await fetch(`/api/internal/communities/chatters/${encodeURIComponent(query)}?map=${encodeURIComponent(map.generatedAt)}`, {
        cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
      });
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setError(response.status === 404 ? "No available recorded activity for that username. Try another name."
          : response.status === 403 ? "An administrator session is required. Log in again to use this lookup."
          : response.status === 409 ? "The map has been updated. Reload this page before searching again."
          : "Chatter activity could not be loaded. Try the search again.");
        return;
      }
      const body = await response.json() as { data: CommunityChatterActivity };
      if (!controller.signal.aborted) onResult(body.data);
    } catch {
      if (!controller.signal.aborted) setError("Chatter activity could not be loaded. Try the search again.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  const nodes = new Map(map.graph.nodes.map(node => [node.id, node]));
  return <section id="community-chatter-lookup" className="community-chatter-lookup" aria-label="Find a chatter">
    <form onSubmit={search}><label htmlFor="community-chatter-name">Chatter username <span>Admin only</span></label>
      <div className="community-chatter-form"><input id="community-chatter-name" className="community-input" value={login} onChange={event => setLogin(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={26} placeholder="Twitch username" />
        <button className="button button-secondary" disabled={loading || login.trim() === ""}>{loading ? "Searching…" : "Highlight"}</button></div>
    </form>
    <p>Channels with at least 3 captured messages or repeated chat presence in this map’s window. Only observations linked reliably to this account are used. They do not prove viewing or preferences.</p>
    {error != null && <p role="alert">{error}</p>}
    {result != null && <>
      <div className="community-list-heading" role="status"><strong>{result.displayName ?? result.login}</strong><span>{result.channels.length} {result.channels.length === 1 ? "channel" : "channels"}</span></div>
      {result.channels.length === 0 ? <p>No qualifying chat activity was recorded in channels on this map. That does not mean they did not watch.</p> : <ul className="community-channel-list">{result.channels.map(channel => {
        const node = nodes.get(channel.channelId);
        if (node == null) return null;
        return <li key={channel.channelId}><button onClick={() => onSelect(node)}><span className="community-color" style={{ background: communityColor(node.community) }} /><span>{channelName(node)}
          <small>{channel.messages > 0 ? `${formatCount(channel.messages)} ${channel.messages === 1 ? "message" : "messages"} · ${channel.messageDays} chat ${channel.messageDays === 1 ? "day" : "days"}` : "No captured messages"}{channel.presenceDays > 0 ? ` · presence on ${channel.presenceDays} days` : ""}</small>
        </span></button></li>;
      })}</ul>}
      <button className="community-text-button" onClick={() => onResult(null)}>Clear highlights</button>
    </>}
  </section>;
}
