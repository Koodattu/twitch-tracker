"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { CommunityMap } from "@twitch-tracker/shared";
import { formatCount, formatDateTime } from "../format";
import { Avatar, EmptyState, MetricCard } from "../ui";

type MapNode = CommunityMap["graph"]["nodes"][number];
const name = (node: MapNode) => node.displayName ?? node.login ?? "Unnamed channel";
const palette = ["#b58aff", "#48d597", "#f4c86b", "#62ccff", "#ff83b4", "#ff9f66", "#80e2d7", "#d5df73"];
function color(id: string | null) {
  if (id == null) return "#a7a1b4";
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}

export function CommunityExplorer({ map }: { map: CommunityMap }) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, size: 1000 });
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean; id: string | null } | null>(null);
  const byId = useMemo(() => new Map(map.graph.nodes.map((node) => [node.id, node])), [map]);
  const communities = useMemo(() => {
    const result = new Map<string, MapNode[]>();
    for (const node of map.graph.nodes) if (node.community != null) {
      if (!result.has(node.community)) result.set(node.community, []);
      result.get(node.community)!.push(node);
    }
    return [...result].map(([id, nodes]) => ({ id, nodes: nodes.sort((a, b) => b.chatters - a.chatters || name(a).localeCompare(name(b))) }))
      .sort((a, b) => b.nodes.length - a.nodes.length || a.id.localeCompare(b.id));
  }, [map]);
  const labels = new Map(communities.map((item) => [item.id, item.nodes.slice(0, 2).map(name).join(" / ")]));
  const selectedNode = selected == null ? null : byId.get(selected);
  const connections = useMemo(() => selected == null ? [] : map.graph.edges.filter((edge) => edge.source === selected || edge.target === selected)
    .map((edge) => ({ ...edge, node: byId.get(edge.source === selected ? edge.target : edge.source)! }))
    .sort((a, b) => b.score - a.score || b.shared - a.shared || name(a.node).localeCompare(name(b.node))), [map, selected, byId]);
  const neighbors = new Set(connections.map((edge) => edge.node.id));
  const matches = map.graph.nodes.filter((node) =>
    (group === "all" || (node.community ?? "ungrouped") === group) &&
    `${name(node)} ${node.login ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => b.chatters - a.chatters || name(a).localeCompare(name(b)));
  const select = (node: MapNode) => {
    setSelected(node.id);
    setView((current) => ({ ...current, x: node.x - current.size / 2, y: node.y - current.size / 2 }));
  };
  const zoom = (factor: number) => setView((current) => {
    const size = Math.min(1600, Math.max(120, current.size * factor));
    return { size, x: current.x + (current.size - size) / 2, y: current.y + (current.size - size) / 2 };
  });
  const reset = () => { setView({ x: 0, y: 0, size: 1000 }); setSelected(null); };
  const position = (clientX: number, clientY: number) => {
    const matrix = svg.current?.getScreenCTM();
    return matrix == null ? null : new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  };
  const dimmed = (node: MapNode) => (group !== "all" && (node.community ?? "ungrouped") !== group) ||
    (selected != null && node.id !== selected && !neighbors.has(node.id));
  const reportingEnd = new Date(new Date(map.windowEnd).getTime() - 1).toISOString().slice(0, 10);

  return <>
    <section className="stat-row" aria-label="Community map summary">
      <MetricCard label="Channels" value={formatCount(map.graph.nodes.length)} />
      <MetricCard label="Communities" value={formatCount(communities.length)} />
      <MetricCard label="Connections" value={formatCount(map.graph.edges.length)} />
      <MetricCard label="Last built" value={formatDateTime(map.generatedAt)} detail="Rebuilt nightly at 03:00 UTC" />
    </section>
    <div className="community-period">{map.windowStart.slice(0, 10)} – {reportingEnd} · 30 completed UTC days</div>
    {map.graph.nodes.length === 0 ? <section className="panel"><EmptyState title="Not enough recorded chat activity" description="No channels meet the activity threshold for this reporting window yet." /></section> :
      <div className="community-layout">
        <section className="community-map" aria-label="Channel community map">
          <div className="community-map-caption"><strong>Finnish chat communities</strong><span>Explore a channel to see its connections</span></div>
          <svg ref={svg} viewBox={`${view.x} ${view.y} ${view.size} ${view.size}`} aria-label="Channels connected by shared active chatters"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              drag.current = { x: event.clientX, y: event.clientY, moved: false,
                id: (event.target as Element).closest("[data-channel]")?.getAttribute("data-channel") ?? null };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const previous = drag.current;
              if (previous == null) return;
              const from = position(previous.x, previous.y), to = position(event.clientX, event.clientY);
              if (from == null || to == null) return;
              if (Math.hypot(event.clientX - previous.x, event.clientY - previous.y) > 2) previous.moved = true;
              if (previous.moved) setView((current) => ({ ...current, x: current.x + from.x - to.x, y: current.y + from.y - to.y }));
              previous.x = event.clientX; previous.y = event.clientY;
            }}
            onPointerUp={(event) => {
              const previous = drag.current; drag.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
              if (previous != null && !previous.moved && previous.id != null) select(byId.get(previous.id)!);
            }} onPointerCancel={() => { drag.current = null; }}>
            <g aria-hidden="true">{map.graph.edges.map((edge) => {
              const a = byId.get(edge.source)!, b = byId.get(edge.target)!;
              const highlighted = selected != null && (edge.source === selected || edge.target === selected);
              return <line key={`${edge.source}-${edge.target}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={highlighted ? color(selectedNode?.community ?? null) : color(a.community)}
                strokeOpacity={highlighted ? 0.8 : selected != null || dimmed(a) || dimmed(b) ? 0.045 : 0.2}
                strokeWidth={highlighted ? 1.3 + edge.score * 2 : 0.4 + edge.score * 1.4} />;
            })}</g>
            {map.graph.nodes.map((node) => {
              const highlighted = node.id === selected || node.id === hovered;
              const radius = Math.min(17, 3 + Math.sqrt(node.chatters) * 0.6);
              return <g key={node.id} data-channel={node.id} className="community-node" role="button" tabIndex={0}
                aria-label={`${name(node)}, ${formatCount(node.chatters)} active chatters`} aria-pressed={node.id === selected}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(node); } }}
                onMouseEnter={() => setHovered(node.id)} onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(node.id)} onBlur={() => setHovered(null)} opacity={dimmed(node) ? 0.22 : 1}>
                <circle cx={node.x} cy={node.y} r={radius + 6} fill="transparent" />
                <circle cx={node.x} cy={node.y} r={radius} fill={color(node.community)} stroke={highlighted ? "#fff" : "none"} strokeWidth={2} />
                {(highlighted || (selected == null && node.chatters >= (matches[9]?.chatters ?? Infinity))) &&
                  <text x={node.x} y={node.y - radius - 6} textAnchor="middle" className="community-node-label" fontSize={highlighted ? 14 : 11}>{name(node)}</text>}
              </g>;
            })}
          </svg>
          <div className="community-map-controls" aria-label="Map controls">
            <button className="button button-secondary" onClick={() => zoom(0.75)} aria-label="Zoom in">+</button>
            <button className="button button-secondary" onClick={() => zoom(1.33)} aria-label="Zoom out">−</button>
            <button className="button button-secondary" onClick={reset}>Reset view</button>
          </div>
          <p className="community-legend">Size: active chatters · Lines: shared chatters · Color: community</p>
        </section>
        <aside className="community-sidebar">
          <section className="panel">
            <h2>Find a channel</h2>
            <label className="sr-only" htmlFor="community-search">Search channels</label>
            <input id="community-search" className="input community-input" type="search" placeholder="Search channels" value={query}
              onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
            <label htmlFor="community-filter">Community</label>
            <select id="community-filter" className="input community-input" value={group} onChange={(event) => { setGroup(event.target.value); setPage(0); }}>
              <option value="all">All communities</option>
              {communities.map((item) => <option key={item.id} value={item.id}>{labels.get(item.id)} ({item.nodes.length})</option>)}
              <option value="ungrouped">Ungrouped channels</option>
            </select>
            <p className="community-muted" aria-live="polite">{formatCount(matches.length)} {matches.length === 1 ? "channel" : "channels"}</p>
            {matches.length === 0 ? <p>Not enough recorded chat activity for this map.</p> : <ul className="community-channel-list">
              {matches.slice(page * 20, page * 20 + 20).map((node) => <li key={node.id}><button onClick={() => select(node)} aria-pressed={selected === node.id}>
                <span className="community-color" style={{ background: color(node.community) }} /><span>{name(node)}</span><small>{formatCount(node.chatters)}</small>
              </button></li>)}
            </ul>}
            {matches.length > 20 && <div className="community-pagination"><button className="button button-secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
              <button className="button button-secondary" disabled={(page + 1) * 20 >= matches.length} onClick={() => setPage(page + 1)}>Next</button></div>}
          </section>
          <section className="panel" aria-live="polite">
            {selectedNode == null ? <><h2>Explore a connection</h2><p>Select a channel on the map or in the list to see where its chat community overlaps.</p></> : <>
              <div className="community-selected"><Avatar name={name(selectedNode)} src={selectedNode.profileImageUrl} size="small" /><h2>{name(selectedNode)}</h2></div>
              <p>{formatCount(selectedNode.chatters)} qualifying active chatters</p>
              <p className="community-muted">{selectedNode.community == null ? "Ungrouped channel" : labels.get(selectedNode.community)}</p>
              {selectedNode.login != null && <Link className="button button-secondary" href={`/channels/${encodeURIComponent(selectedNode.login)}`}>Channel profile</Link>}
              <h3>Strongest connections</h3>
              {connections.length === 0 ? <p>No connections meet the shared-chatter threshold.</p> : <ul className="community-channel-list">
                {connections.map((edge) => <li key={edge.node.id}><button onClick={() => select(edge.node)}><span>{name(edge.node)}<small>{formatCount(edge.shared)} shared chatters</small></span>
                  <strong>{Math.round(edge.shared / selectedNode.chatters * 100)}%</strong></button></li>)}
              </ul>}
              {connections.length > 0 && <p className="community-muted">Percentages are shares of {name(selectedNode)}’s qualifying chatters.</p>}
            </>}
          </section>
        </aside>
      </div>}
    <section className="panel community-explanation">
      <h2>Reading the map</h2>
      <p>These connections come from recorded chat messages, not all viewers or followers. A person qualifies after sending at least 3 messages in a channel during the reporting window. Channels need 10 qualifying chatters; connections need 5 shared chatters. Only the strongest connections are shown.</p>
      <p>Colors group channels with overlapping chats. Position is not geographic, and a connection does not establish friendship or affiliation. Untyped viewing, collection interruptions, and channels we could not track are not represented.</p>
      <p className="community-muted">Qualifying observations: {formatDateTime(map.coverage.firstObservedAt)} – {formatDateTime(map.coverage.lastObservedAt)}.</p>
      {map.coverage.unknownSource > 0 && <p>Some historical messages could not be verified as original channel messages and were excluded.</p>}
    </section>
  </>;
}
