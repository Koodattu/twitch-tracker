"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { communityNodeRadius, type CommunityMap } from "@twitch-tracker/shared";
import { formatCount, formatDateTime } from "../format";
import { Avatar, EmptyState } from "../ui";
import { fitCommunityView, transformCamera, type MapView } from "./map-camera";
import { placeMapLabels } from "./map-labels";
import { summarizeCommunityCategories } from "./map-categories";

type MapNode = CommunityMap["graph"]["nodes"][number];
const participants = (node: MapNode) => node.participants ?? node.chatters;
const nodeRadius = (node: MapNode) => communityNodeRadius(participants(node));
const name = (node: MapNode) => node.displayName ?? node.login ?? "Unnamed channel";
function color(id: string | null) {
  if (id == null) return "#a7a1b4";
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 78% 68%)`;
}

// Camera movement only changes the SVG viewBox, leaving the graph artwork intact.
const MapArtwork = memo(function MapArtwork({ map, matches, selected, hovered, hideUnconnected, onHover, onSelect }: {
  map: CommunityMap; matches: MapNode[]; selected: string | null; hovered: string | null;
  hideUnconnected: boolean;
  onHover: (id: string | null) => void; onSelect: (node: MapNode) => void;
}) {
  const byId = new Map(map.graph.nodes.map((node) => [node.id, node]));
  const matching = new Set(matches.map((node) => node.id));
  const neighbors = new Set(map.graph.edges.filter((edge) => edge.source === selected || edge.target === selected)
    .flatMap((edge) => [edge.source, edge.target]));
  const dimmed = (id: string) => !matching.has(id) || (selected != null && id !== selected && !neighbors.has(id));
  return <>
    <g aria-hidden="true">{map.graph.edges.map((edge) => {
      const a = byId.get(edge.source)!, b = byId.get(edge.target)!;
      const highlighted = selected != null && (edge.source === selected || edge.target === selected);
      return <line key={`${edge.source}-${edge.target}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
        stroke={color(highlighted ? byId.get(selected!)!.community : a.community)}
        strokeOpacity={highlighted ? 0.75 : dimmed(a.id) || dimmed(b.id) ? 0.025 : 0.16}
        strokeWidth={highlighted ? 1.2 + edge.score * 1.5 : 0.35 + edge.score} />;
    })}</g>
    {map.graph.nodes.map((node) => {
      if (hideUnconnected && node.community == null && node.id !== selected) return null;
      const highlighted = node.id === selected || node.id === hovered;
      const radius = nodeRadius(node);
      return <g key={node.id} data-channel={node.id} className="community-node" style={{ "--community-node-radius": `${radius}px` } as CSSProperties} role="button" tabIndex={node.id === selected ? 0 : -1}
        aria-label={`${name(node)}, ${formatCount(participants(node))} people observed in chat`} aria-pressed={node.id === selected}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(node); } }}
        onMouseEnter={() => onHover(node.id)} onMouseLeave={() => onHover(null)}
        onFocus={() => onHover(node.id)} onBlur={() => onHover(null)} opacity={dimmed(node.id) ? 0.16 : 1}>
        <circle className="community-node-hit" cx={node.x} cy={node.y} r={radius + 7} fill="transparent" />
        {highlighted && <circle className="community-node-halo" cx={node.x} cy={node.y} r={radius + 5} fill="none" stroke={color(node.community)} strokeOpacity={0.6} />}
        <circle className="community-node-dot" cx={node.x} cy={node.y} r={radius} fill={color(node.community)} stroke={highlighted ? "#fff" : "none"} strokeWidth={1.5} />
      </g>;
    })}
  </>;
});

function MapLabels({ map, matches, selected, hovered, view, width, height, hideUnconnected, referenceSize }: {
  map: CommunityMap; matches: MapNode[]; selected: string | null; hovered: string | null;
  view: MapView; width: number; height: number; hideUnconnected: boolean; referenceSize: number;
}) {
  const [textWidths, setTextWidths] = useState(new Map<string, number>());
  const layer = useRef<SVGGElement>(null);
  useEffect(() => {
    const context = document.createElement("canvas").getContext("2d");
    if (context == null || layer.current == null) return;
    context.font = `650 12px ${getComputedStyle(layer.current).fontFamily}`;
    setTextWidths(new Map(map.graph.nodes.map((node) => [node.id, context.measureText(name(node)).width])));
  }, [map]);
  const neighbors = new Set(map.graph.edges.filter((edge) => edge.source === selected || edge.target === selected)
    .flatMap((edge) => [edge.source, edge.target]));
  const candidates = matches.filter((node) =>
    (!hideUnconnected || node.community != null || node.id === selected) &&
    (selected == null || neighbors.has(node.id) || node.id === selected || node.id === hovered));
  const byId = new Map(candidates.map((node) => [node.id, node]));
  const placed = placeMapLabels(candidates.map((node) => ({ id: node.id, x: node.x, y: node.y,
    radius: nodeRadius(node), width: textWidths.get(node.id) ?? name(node).length * 7.2,
    audience: participants(node), priority: node.id === selected ? 3 : node.id === hovered ? 2 : 1 })), view, width, height, referenceSize);
  return <g ref={layer} aria-hidden="true">{placed.map(({ id, x, y }) =>
    <text key={id} data-label-channel={id} x={x} y={y} textAnchor="middle" className="community-node-label">{name(byId.get(id)!)}</text>
  )}</g>;
}

export function CommunityExplorer({ map }: { map: CommunityMap }) {
  const thresholds = map.coverage.thresholds ?? { channelPeople: 10, sharedPeople: 5 };
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [page, setPage] = useState(0);
  const homeView = useMemo(() => fitCommunityView(map.graph.nodes), [map]);
  const [view, setView] = useState(homeView);
  const [mapSize, setMapSize] = useState({ width: 1000, height: 1000 });
  const [hideUnconnected, setHideUnconnected] = useState(false);
  const mapSide = Math.max(1, Math.min(mapSize.width, mapSize.height));
  const unconnectedCount = map.graph.nodes.filter((node) => node.community == null).length;
  const svg = useRef<SVGSVGElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; moved: boolean; id: string | null } | null>(null);
  const byId = useMemo(() => new Map(map.graph.nodes.map((node) => [node.id, node])), [map]);
  const communities = useMemo(() => {
    const result = new Map<string, MapNode[]>();
    for (const node of map.graph.nodes) if (node.community != null) {
      if (!result.has(node.community)) result.set(node.community, []);
      result.get(node.community)!.push(node);
    }
    return [...result].map(([id, nodes]) => ({ id, nodes: nodes.sort((a, b) => participants(b) - participants(a) || name(a).localeCompare(name(b))) }))
      .sort((a, b) => b.nodes.length - a.nodes.length || a.id.localeCompare(b.id));
  }, [map]);
  const labels = new Map(communities.map((item) => [item.id, item.nodes.slice(0, 2).map(name).join(" / ")]));
  const categorySummaries = useMemo(() => new Map(communities.map((item) => [item.id, summarizeCommunityCategories(item.nodes)])), [communities]);
  const selectedNode = selected == null ? null : byId.get(selected);
  const categorySummary = selectedNode?.community == null ? null : categorySummaries.get(selectedNode.community);
  const connections = useMemo(() => selected == null ? [] : map.graph.edges.filter((edge) => edge.source === selected || edge.target === selected)
    .map((edge) => ({ ...edge, node: byId.get(edge.source === selected ? edge.target : edge.source)! }))
    .sort((a, b) => b.score - a.score || b.shared - a.shared || name(a.node).localeCompare(name(b.node))), [map, selected, byId]);
  const matches = useMemo(() => map.graph.nodes.filter((node) =>
    (group === "all" || (node.community ?? "ungrouped") === group) &&
    `${name(node)} ${node.login ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => participants(b) - participants(a) || name(a).localeCompare(name(b))), [map, group, query]);
  const select = useCallback((node: MapNode) => {
    setSelected(node.id); setSearchOpen(false); setHelpOpen(false); setQuery(""); setGroup("all"); setPage(0);
    setView((current) => {
      const size = Math.min(current.size, 650);
      const next = { size, x: node.x - size / 2, y: node.y - size / 2 };
      const bounds = svg.current?.getBoundingClientRect();
      if (bounds == null || bounds.width > 760) return next;
      const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      return transformCamera(next, bounds, center, { ...center, y: bounds.top + bounds.height * 0.38 });
    });
    svg.current?.focus({ preventScroll: true });
  }, []);
  const zoom = (factor: number) => setView((current) => {
    const bounds = svg.current?.getBoundingClientRect();
    if (bounds == null) return current;
    const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    return transformCamera(current, bounds, center, center, factor, homeView.size * 2);
  });
  const reset = () => { setView(homeView); setSelected(null); setHovered(null); setQuery(""); setGroup("all"); setHideUnconnected(false); setSearchOpen(false); setPage(0); };
  useEffect(() => {
    const element = svg.current;
    if (element == null) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      const cursor = { x: event.clientX, y: event.clientY };
      setView((current) => transformCamera(current, bounds, cursor, cursor, Math.exp(Math.max(-120, Math.min(120, delta)) * 0.0025), homeView.size * 2));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    const resize = new ResizeObserver(([entry]) => {
      if (entry != null) setMapSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    resize.observe(element);
    return () => { element.removeEventListener("wheel", wheel); resize.disconnect(); };
  }, [homeView.size]);
  const reportingEnd = new Date(new Date(map.windowEnd).getTime() - 1).toISOString().slice(0, 10);

  return <div className="community-explorer" onKeyDown={(event) => {
    if (event.key === "Escape") { setSelected(null); setSearchOpen(false); setHelpOpen(false); svg.current?.focus({ preventScroll: true }); }
  }}>
    <svg className="community-canvas" ref={svg} viewBox={`${view.x} ${view.y} ${view.size} ${view.size}`} tabIndex={0}
      style={{ "--community-unit": `${view.size / mapSide}px`, "--community-label-size": `${view.size / mapSide * 12}px` } as CSSProperties}
      aria-label={selectedNode == null ? "Finnish channel community map" : `Community map, ${name(selectedNode)} selected`}
      aria-describedby="community-gesture-help"
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const step = steps[event.key];
        if (step != null) { event.preventDefault(); setView((current) => ({ ...current, x: current.x + step[0] * current.size * 0.1, y: current.y + step[1] * current.size * 0.1 })); }
        else if (["+", "=", "-", "Home", "/"].includes(event.key)) {
          event.preventDefault();
          if (event.key === "Home") reset();
          else if (event.key === "/") search.current?.focus();
          else zoom(event.key === "-" ? 1.25 : 0.8);
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.current.size === 1) drag.current = { x: event.clientX, y: event.clientY, moved: false,
          id: (event.target as Element).closest("[data-channel]")?.getAttribute("data-channel") ?? null };
        else if (drag.current != null) drag.current.moved = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!pointers.current.has(event.pointerId)) return;
        const before = [...pointers.current.values()];
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const after = [...pointers.current.values()];
        const gesture = drag.current;
        if (gesture == null) return;
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 4) gesture.moved = true;
        if (!gesture.moved) return;
        const center = (points: Array<{ x: number; y: number }>) => ({ x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length });
        const distance = (points: Array<{ x: number; y: number }>) => points.length < 2 ? 1 : Math.max(1, Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y));
        const bounds = event.currentTarget.getBoundingClientRect();
        setView((current) => transformCamera(current, bounds, center(before), center(after), distance(before) / distance(after), homeView.size * 2));
      }}
      onPointerUp={(event) => {
        pointers.current.delete(event.pointerId);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (pointers.current.size > 0) return;
        const gesture = drag.current; drag.current = null;
        if (gesture != null && !gesture.moved) {
          if (gesture.id != null) select(byId.get(gesture.id)!);
          else { setSelected(null); setSearchOpen(false); setHelpOpen(false); }
        }
      }} onPointerCancel={() => { pointers.current.clear(); drag.current = null; }}>
      <MapArtwork map={map} matches={matches} selected={selected} hovered={hovered} hideUnconnected={hideUnconnected} onHover={setHovered} onSelect={select} />
      <MapLabels map={map} matches={matches} selected={selected} hovered={hovered} view={view}
        width={mapSize.width} height={mapSize.height} hideUnconnected={hideUnconnected} referenceSize={homeView.size} />
    </svg>

    <div className="community-heading"><span className="eyebrow">Discover · Finnish Twitch</span><h1>Chat communities</h1>
      <p>{formatCount(map.graph.nodes.length)} channels <span>·</span> {formatCount(communities.length)} {communities.length === 1 ? "community" : "communities"}</p></div>
    <div className="community-date"><strong>30-day map</strong><span>Updated {formatDateTime(map.generatedAt)}</span></div>

    {map.graph.nodes.length === 0 ? <div className="community-empty community-glass"><EmptyState title="Not enough recorded chat activity" description="No channels meet the activity threshold for this reporting window yet." /></div> :
      <section className="community-search community-glass" aria-label="Find a channel">
        <div className="community-search-bar"><span aria-hidden="true">⌕</span>
          <input ref={search} id="community-search" type="search" placeholder="Find a channel…" aria-label="Search channels" value={query}
            onFocus={() => { setSearchOpen(true); setHelpOpen(false); setSelected(null); }}
            onChange={(event) => { setQuery(event.target.value); setPage(0); setSelected(null); setSearchOpen(true); }} />
          <button className="community-icon-button" aria-label={searchOpen ? "Collapse channel search" : "Browse channels"} aria-expanded={searchOpen} aria-controls="community-search-results"
            onClick={() => { setSearchOpen(!searchOpen); setHelpOpen(false); }}>{searchOpen ? "−" : "+"}</button>
        </div>
        {unconnectedCount > 0 && <label className="community-ring-control"><input type="checkbox" checked={hideUnconnected}
          onChange={(event) => { setHideUnconnected(event.target.checked); if (event.target.checked && selectedNode?.community == null) setSelected(null); }} />
          Hide unconnected channels ({formatCount(unconnectedCount)})</label>}
        {searchOpen && <div id="community-search-results" className="community-search-results">
          <label htmlFor="community-filter">Community</label>
          <select id="community-filter" className="community-input" value={group} onChange={(event) => {
            const next = event.target.value; setGroup(next); setPage(0); setSelected(null);
            if (next === "ungrouped") setHideUnconnected(false);
            const nodes = map.graph.nodes.filter((node) => (node.community ?? "ungrouped") === next);
            if (next === "all") setView(homeView);
            else if (nodes.length > 0) {
              const xs = nodes.map((node) => node.x), ys = nodes.map((node) => node.y);
              const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
              const size = Math.max(300, Math.max(right - left, bottom - top) * 1.4);
              setView({ x: (left + right - size) / 2, y: (top + bottom - size) / 2, size });
            }
          }}><option value="all">All communities</option>
            {communities.map((item) => <option key={item.id} value={item.id}>{labels.get(item.id)} ({item.nodes.length}){categorySummaries.get(item.id) == null ? "" : ` · ${categorySummaries.get(item.id)!.title}`}</option>)}
            <option value="ungrouped">No connections ({unconnectedCount})</option>
          </select>
          <div className="community-list-heading"><span aria-live="polite">{formatCount(matches.length)} {matches.length === 1 ? "channel" : "channels"}</span><span>People</span></div>
          {matches.length === 0 ? <p className="community-no-results">No matching channels. Try another name or community. Some channels may not have enough recorded chat activity yet.</p> :
            <ul className="community-channel-list">{matches.slice(page * 8, page * 8 + 8).map((node) => <li key={node.id}><button onClick={() => select(node)} aria-pressed={selected === node.id}>
              <span className="community-color" style={{ background: color(node.community) }} /><span>{name(node)}</span><small>{formatCount(participants(node))}</small>
            </button></li>)}</ul>}
          {matches.length > 8 && <div className="community-pagination"><button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>{page + 1} / {Math.ceil(matches.length / 8)}</span>
            <button disabled={(page + 1) * 8 >= matches.length} onClick={() => setPage(page + 1)}>Next</button></div>}
        </div>}
      </section>}

    {selectedNode != null && <section className="community-details community-glass" aria-label="Selected channel">
      <div className="community-panel-heading"><span className="eyebrow">Channel connections</span><button className="community-icon-button" aria-label="Close channel details" onClick={() => { setSelected(null); svg.current?.focus(); }}>×</button></div>
      <div className="community-selected"><Avatar name={name(selectedNode)} src={selectedNode.profileImageUrl} size="small" /><h2>{name(selectedNode)}</h2></div>
      <div className="community-selected-stats"><strong>{formatCount(participants(selectedNode))}<span>people observed in chat</span></strong><strong>{formatCount(connections.length)}<span>connections</span></strong></div>
      <p className="community-group-name"><span className="community-color" style={{ background: color(selectedNode.community) }} />{selectedNode.community == null ? "No qualifying connections" : labels.get(selectedNode.community)}</p>
      {categorySummary != null && <section className="community-category-summary" aria-label="Community categories">
        <h3>{categorySummary.title}</h3>
        <ul>{categorySummary.categories.map((category) => <li key={category.id}><span>{category.name}</span><span>{category.channels} / {categorySummary.known} channels</span></li>)}</ul>
        {categorySummary.mixed > 0 && <p>{categorySummary.mixed} {categorySummary.mixed === 1 ? "channel splits" : "channels split"} time across categories.</p>}
        <p>Based on recorded category time in this 30-day window. Each channel counts once. Shared people determine the connections.</p>
        {categorySummary.known < categorySummary.total && <p>Category information covers {categorySummary.known} of {categorySummary.total} channels.</p>}
      </section>}
      {selectedNode.login != null && <Link className="community-profile-link" href={`/channels/${encodeURIComponent(selectedNode.login)}`}>View channel profile <span aria-hidden="true">↗</span></Link>}
      <div className="community-connections"><h3>Strongest connections</h3>
        <p>Shared people · share of {name(selectedNode)}’s chat</p>
        {connections.length === 0 ? <p>This channel meets the {thresholds.channelPeople}-person threshold, but shares fewer than {thresholds.sharedPeople} qualifying people with every other qualifying channel in this window. The outer ring keeps it searchable; its position does not represent distance from a community.</p> : <ul className="community-channel-list">
          {connections.map((edge) => <li key={edge.node.id}><button onClick={() => select(edge.node)}><span className="community-color" style={{ background: color(edge.node.community) }} /><span>{name(edge.node)}<small>{formatCount(edge.shared)} shared people</small></span>
            <strong>{Math.round(edge.shared / participants(selectedNode) * 100)}%</strong></button></li>)}
        </ul>}
      </div>
    </section>}

    <div className="community-bottom-bar"><button className="community-help-button community-glass" aria-expanded={helpOpen} aria-controls="community-explanation" onClick={() => { setHelpOpen(!helpOpen); setSearchOpen(false); }}>How it works <span aria-hidden="true">?</span></button>
      <span className="community-hint">Scroll to zoom · Drag to explore · Select a channel</span></div>
    <div className="community-map-controls community-glass" aria-label="Map controls">
      <button aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoom(0.8)}>+</button><button aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoom(1.25)}>−</button>
      <span className="community-zoom-level">{Math.round(homeView.size / view.size * 100)}%</span>
      <button className="community-fit" onClick={reset} title="Reset zoom and filters (Home)">Fit map</button>
    </div>
    {helpOpen && <section id="community-explanation" className="community-explanation community-glass" aria-labelledby="community-help-title">
      <div className="community-panel-heading"><h2 id="community-help-title">Reading the map</h2><button className="community-icon-button" aria-label="Close explanation" onClick={() => setHelpOpen(false)}>×</button></div>
      <p><strong>Each dot is a channel.</strong> Larger dots have more people observed in chat. Lines connect channels with shared people, and colors show detected communities.</p>
      <p>These are recorded chat communities, not all viewers or followers. Position is not geographic, and connections do not establish friendship or affiliation.</p>
      <p>People qualify after 3 messages in a channel{map.coverage.presence != null ? ", or presence on at least two UTC dates at least six hours apart" : ""}. Channels need {thresholds.channelPeople} qualifying people; connections need {thresholds.sharedPeople} shared people. Each channel keeps its 10 strongest connections; a connection is shown when either endpoint keeps it.</p>
      <p>Larger channels get labels first. Selecting a channel shows names for its connections; zoom in to reveal smaller names as space opens up.</p>
      <p>Community category descriptions summarize recorded streaming time. A channel mainly streams a category when it accounts for at least 60% of its known category time. “Mostly” requires 60% of channels with category information to share that main category. Mixed categories can reflect variety streamers or different interests within a community; categories do not prove why people move between channels.</p>
      <p>The gray outer ring contains channels with no retained connections. They meet the {thresholds.channelPeople}-person threshold, but no other qualifying channel shares at least {thresholds.sharedPeople} qualifying people with them. Their position is only a way to keep them visible. You can hide them with the checkbox below search.</p>
      {map.coverage.presence != null && <>
        <p>Repeated presence includes people who do not write messages. It contributes one-quarter of the connection weight of messages. People seen through both sources count once.</p>
        <p>Chat presence does not prove someone watched the video. JOIN/PART coverage is incomplete, especially in rooms above 1,000 users. Missing observations do not mean someone was absent. Accounts observed across more than 50 channels contribute through messages only.</p>
        <p>Presence was recorded in {formatCount(map.coverage.presence.observedChannels)} channels; {formatCount(map.coverage.presence.presenceOnlyMemberships)} qualifying person–channel connections came from presence alone. Individual identities are never included in this map.</p>
        {map.coverage.presence.unresolvedEvents > 0 && <p>Some older presence observations could not be linked reliably to an account and were excluded.</p>}
      </>}
      <dl><dt>Reporting window</dt><dd>{map.windowStart.slice(0, 10)} – {reportingEnd} (UTC)</dd><dt>Last built</dt><dd>{formatDateTime(map.generatedAt)} · nightly at 03:00 UTC</dd>
        <dt>Qualifying observations</dt><dd>{formatDateTime(map.coverage.firstObservedAt)} – {formatDateTime(map.coverage.lastObservedAt)}</dd></dl>
      {map.coverage.unknownSource > 0 && <p>Some historical messages could not be verified as original channel messages and were excluded.</p>}
      <p>Scroll or pinch to zoom. Drag to pan. With the map focused, use arrow keys to pan, + / − to zoom, Home to reset, or / to search. Escape closes panels.</p>
    </section>}
    <p id="community-gesture-help" className="sr-only">Scroll or pinch to zoom. Drag or use arrow keys to pan. Plus and minus zoom; Home resets the map. Use Search channels to select a channel with the keyboard. Escape closes panels.</p>
  </div>;
}
