"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import { communityNodeRadius, type CommunityMap, type CommunityChatterActivity } from "@twitch-tracker/shared";
import { formatCount, formatDateTime } from "../format";
import { EmptyState } from "../ui";
import { fitCommunityView, transformCamera, type MapView } from "./map-camera";
import { placeMapLabels } from "./map-labels";
import { summarizeCommunityCategories } from "./map-categories";
import { channelName as name, communityColor as color, participants, connectionCounts, communityArea, type MapNode } from "./map-data";
import { ChannelDetails } from "./channel-details";
import { ChatterLookup } from "./chatter-lookup";

const nodeRadius = (node: MapNode) => communityNodeRadius(participants(node));
type CategoryArea = { id: string; title: string; x: number; y: number; radius: number };

function setSelected(id: string | null) {
  const url = new URL(window.location.href);
  url.searchParams.delete("channel");
  if (id != null) url.searchParams.set("channel", id);
  if (url.href !== window.location.href) window.history.pushState(null, "", url);
}

function locateChannel(node: MapNode, size: number, bounds: { width: number; height: number }): MapView {
  const view = { size, x: node.x - size / 2, y: node.y - size / 2 };
  if (bounds.width > 760) return view;
  const center = { x: bounds.width / 2, y: bounds.height / 2 };
  return transformCamera(view, { ...bounds, left: 0, top: 0 }, center, { ...center, y: bounds.height * 0.38 });
}

// Connections do not use screen-sized CSS properties and need no work on hover or zoom.
const MapConnections = memo(function MapConnections({ map, selected, dimmed }: {
  map: CommunityMap; selected: string | null; dimmed: Set<string>;
}) {
  const byId = new Map(map.graph.nodes.map((node) => [node.id, node]));
  return <g aria-hidden="true" data-community-connections>{map.graph.edges.map((edge) => {
    const a = byId.get(edge.source)!, b = byId.get(edge.target)!;
    const highlighted = selected != null && (edge.source === selected || edge.target === selected);
    return <line key={`${edge.source}-${edge.target}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
      stroke={color(highlighted ? byId.get(selected!)!.community : a.community)}
      strokeOpacity={highlighted ? 0.75 : dimmed.has(a.id) || dimmed.has(b.id) ? 0.025 : 0.16}
      strokeWidth={highlighted ? 1.2 + edge.score * 1.5 : 0.35 + edge.score} />;
  })}</g>;
});

const MapArtwork = memo(function MapArtwork({ map, selected, hovered, dimmed, highlighted, onHover, onSelect }: {
  map: CommunityMap; selected: string | null; hovered: string | null; dimmed: Set<string>; highlighted: Set<string> | null;
  onHover: (id: string | null) => void; onSelect: (node: MapNode) => void;
}) {
  return <>
    {map.graph.nodes.map((node) => {
      const emphasized = node.id === selected || node.id === hovered;
      const chatterMatch = highlighted?.has(node.id) === true;
      const radius = nodeRadius(node);
      // Fade the shapes without creating a separate opacity group for every channel.
      const opacity = dimmed.has(node.id) ? 0.16 : 1;
      return <g key={node.id} data-channel={node.id} data-chatter-match={chatterMatch || undefined} className="community-node" style={{ "--community-node-radius": `${radius}px` } as CSSProperties} role="button" tabIndex={node.id === selected ? 0 : -1}
        aria-label={`${name(node)}, ${formatCount(participants(node))} people observed in chat`} aria-pressed={node.id === selected}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(node); } }}
        onFocus={() => onHover(node.id)} onBlur={() => onHover(null)}>
        <circle className="community-node-hit" cx={node.x} cy={node.y} r={radius + 7} fill="transparent" />
        {(emphasized || chatterMatch) && <circle className="community-node-halo" cx={node.x} cy={node.y} r={radius + 5} fill="none" stroke={chatterMatch ? "#fff" : color(node.community)} strokeOpacity={(chatterMatch ? 1 : 0.6) * opacity} />}
        <circle className="community-node-dot" cx={node.x} cy={node.y} r={radius} fill={color(node.community)} fillOpacity={opacity} stroke={emphasized ? "#fff" : "none"} strokeOpacity={opacity} strokeWidth={1.5} />
      </g>;
    })}
  </>;
});

const MapLabels = memo(function MapLabels({ map, matches, selected, view, width, height, highlighted, areas }: {
  map: CommunityMap; matches: MapNode[]; selected: string | null;
  view: MapView; width: number; height: number; highlighted: Set<string> | null; areas: CategoryArea[];
}) {
  const [textWidths, setTextWidths] = useState(new Map<string, number>());
  const layer = useRef<SVGGElement>(null);
  useEffect(() => {
    const context = document.createElement("canvas").getContext("2d");
    if (context == null || layer.current == null) return;
    context.font = `650 12px ${getComputedStyle(layer.current).fontFamily}`;
    const widths = new Map(map.graph.nodes.map((node) => [node.id, context.measureText(name(node)).width]));
    context.font = `650 13px ${getComputedStyle(layer.current).fontFamily}`;
    for (const area of areas) widths.set(`area:${area.id}`, context.measureText(area.title).width);
    setTextWidths(widths);
  }, [map, areas]);
  const neighbors = new Set(map.graph.edges.filter((edge) => edge.source === selected || edge.target === selected)
    .flatMap((edge) => [edge.source, edge.target]));
  const visible = new Set(map.graph.nodes.map(node => node.id));
  const candidates = matches.filter(node => visible.has(node.id));
  const byId = new Map(candidates.map((node) => [node.id, node]));
  const areaById = new Map(areas.map(area => [`area:${area.id}`, area]));
  const placed = placeMapLabels([...candidates.map((node) => ({ id: node.id, x: node.x, y: node.y,
    radius: nodeRadius(node), width: textWidths.get(node.id) ?? name(node).length * 7.2,
    audience: participants(node), priority: node.id === selected ? 3 : neighbors.has(node.id) || highlighted?.has(node.id) ? 2 : 1 })),
    ...areas.map(area => ({ id: `area:${area.id}`, x: area.x, y: area.y - area.radius, radius: 0,
      width: textWidths.get(`area:${area.id}`) ?? area.title.length * 8, audience: 0, priority: 4 }))], view, width, height);
  const unit = view.size / Math.max(1, Math.min(width, height));
  return <g ref={layer} aria-hidden="true" style={{ "--community-unit": `${unit}px`, "--community-label-size": `${unit * 12}px` } as CSSProperties}>{placed.map(({ id, x, y }) => {
    const area = areaById.get(id);
    return area != null ? <text key={id} x={x} y={y} textAnchor="middle" className="community-area-label">{area.title}</text>
      : <text key={id} data-label-channel={id} x={x} y={y} textAnchor="middle" className="community-node-label"
        opacity={highlighted != null && !highlighted.has(id) && id !== selected ? 0.28 : 1}>{name(byId.get(id)!)}</text>;
  })}</g>;
});

export function CommunityExplorer({ map, canLookupChatter = false }: { map: CommunityMap; canLookupChatter?: boolean }) {
  const params = useSearchParams();
  const requested = params.getAll("channel");
  const byId = useMemo(() => new Map(map.graph.nodes.map((node) => [node.id, node])), [map]);
  const selected = requested.length === 1 && byId.has(requested[0]!) ? requested[0]! : null;
  const selectedNode = selected == null ? null : byId.get(selected)!;
  const thresholds = map.coverage.thresholds ?? { channelPeople: 10, sharedPeople: 5 };
  const degrees = useMemo(() => connectionCounts(map), [map]);
  const hasDenseChannels = [...degrees.values()].some(degree => degree >= 3);
  const [hideSparse, setHideSparse] = useState(hasDenseChannels);
  const [showConnections, setShowConnections] = useState(true);
  const [showAreas, setShowAreas] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);
  const [chatter, setChatter] = useState<CommunityChatterActivity | null>(null);
  const highlighted = useMemo(() => chatter == null || chatter.channels.length === 0 ? null : new Set(chatter.channels.map(channel => channel.channelId)), [chatter]);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [hovered, setHovered] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [page, setPage] = useState(0);
  const hasConnectedChannels = map.graph.nodes.some((node) => node.community != null);
  const [hideUnconnected, setHideUnconnected] = useState(hasConnectedChannels);
  const sparseCount = [...degrees.values()].filter(degree => degree > 0 && degree < 3).length;
  const connections = useMemo(() => selected == null ? [] : map.graph.edges.filter((edge) => edge.source === selected || edge.target === selected)
    .map((edge) => ({ ...edge, node: byId.get(edge.source === selected ? edge.target : edge.source)! })), [map, selected, byId]);
  const matches = useMemo(() => map.graph.nodes.filter((node) =>
    (group === "all" || (node.community ?? "ungrouped") === group) &&
    `${name(node)} ${node.login ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => participants(b) - participants(a) || name(a).localeCompare(name(b))), [map, group, query]);
  const visibleMap = useMemo(() => {
    const revealed = new Set([selected, ...highlighted ?? [], ...connections.map(connection => connection.node.id)]);
    if (group !== "all" || query.trim() !== "") for (const node of matches) revealed.add(node.id);
    const nodes = map.graph.nodes.filter(node => revealed.has(node.id)
      || ((!hideUnconnected || (degrees.get(node.id) ?? 0) > 0) && (!hideSparse || (degrees.get(node.id) ?? 0) === 0 || (degrees.get(node.id) ?? 0) >= 3)));
    const visible = new Set(nodes.map(node => node.id));
    return { ...map, graph: { nodes, edges: map.graph.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target)) } };
  }, [map, selected, highlighted, connections, group, query, matches, hideUnconnected, hideSparse, degrees]);
  const dimmed = useMemo(() => {
    const matching = new Set(matches.map(node => node.id));
    const neighbors = new Set(connections.map(connection => connection.node.id));
    return new Set(visibleMap.graph.nodes.filter(node => !matching.has(node.id) || (highlighted != null
      ? !highlighted.has(node.id) && node.id !== selected
      : selected != null && node.id !== selected && !neighbors.has(node.id))).map(node => node.id));
  }, [visibleMap, matches, connections, highlighted, selected]);
  const connectedView = useMemo(() => fitCommunityView(map.graph.nodes.filter((node) => node.community != null)), [map]);
  const allView = useMemo(() => fitCommunityView(map.graph.nodes), [map]);
  const homeView = hideUnconnected ? connectedView : allView;
  const [mapSize, setMapSize] = useState({ width: 1000, height: 1000 });
  const initialView = useMemo(() => selectedNode == null ? homeView : locateChannel(selectedNode, 650, mapSize), [selectedNode, homeView, mapSize]);
  // Keep gestures local to their selected channel; history restores a useful neighborhood.
  const [camera, setCamera] = useState<{ selected: string | null; view: MapView } | null>(null);
  const view = camera?.selected === selected ? camera.view : initialView;
  const setView = useCallback((next: MapView | ((current: MapView) => MapView)) => {
    setCamera((current) => ({ selected, view: typeof next === "function" ? next(current?.selected === selected ? current.view : initialView) : next }));
  }, [selected, initialView]);
  const mapSide = Math.max(1, Math.min(mapSize.width, mapSize.height));
  const unconnectedCount = map.graph.nodes.filter((node) => node.community == null).length;
  const svg = useRef<SVGSVGElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<{ x: number; y: number; moved: boolean; id: string | null } | null>(null);
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
  const areas = useMemo(() => showAreas ? communities.filter(community => group === "all" || group === community.id).flatMap(community => {
    const area = communityArea(community.nodes);
    return area == null ? [] : [{ ...area, id: community.id, title: categorySummaries.get(community.id)?.title ?? "Category unknown" }];
  }) : [], [showAreas, communities, categorySummaries, group]);
  const select = useCallback((node: MapNode, locate = false) => {
    setCamera((current) => {
      const currentView = current?.selected === selected ? current.view : initialView;
      return { selected: node.id, view: locate ? locateChannel(node, Math.min(currentView.size, 650), mapSize) : currentView };
    });
    setSelected(node.id); setSearchOpen(false); setHelpOpen(false); setOptionsOpen(false); setLookupOpen(false); setQuery(""); setGroup("all"); setPage(0);
    svg.current?.focus({ preventScroll: true });
  }, [selected, initialView, mapSize]);
  const zoom = (factor: number) => setView((current) => {
    const bounds = svg.current?.getBoundingClientRect();
    if (bounds == null) return current;
    const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    return transformCamera(current, bounds, center, center, factor, homeView.size * 2);
  });
  const reset = () => { setCamera(null); setSelected(null); setHovered(null); setQuery(""); setGroup("all"); setHideUnconnected(hasConnectedChannels); setHideSparse(hasDenseChannels); setChatter(null); setSearchOpen(false); setOptionsOpen(false); setLookupOpen(false); setPage(0); };
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
    return () => element.removeEventListener("wheel", wheel);
  }, [homeView.size, setView]);
  useEffect(() => {
    const element = svg.current;
    if (element == null) return;
    const resize = new ResizeObserver(([entry]) => {
      if (entry != null) setMapSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  const reportingEnd = new Date(new Date(map.windowEnd).getTime() - 1).toISOString().slice(0, 10);

  return <div className="community-explorer" data-search-open={searchOpen || optionsOpen || lookupOpen} onKeyDown={(event) => {
    if (event.key === "Escape") { setSelected(null); setSearchOpen(false); setHelpOpen(false); setOptionsOpen(false); setLookupOpen(false); svg.current?.focus({ preventScroll: true }); }
  }}>
    <svg className="community-canvas" ref={svg} viewBox={`${view.x} ${view.y} ${view.size} ${view.size}`} tabIndex={0}
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
        event.preventDefault();
        svg.current?.focus({ preventScroll: true });
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.current.size === 1) drag.current = { x: event.clientX, y: event.clientY, moved: false,
          id: (event.target as Element).closest("[data-channel]")?.getAttribute("data-channel") ?? null };
        else if (drag.current != null) drag.current.moved = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!pointers.current.has(event.pointerId)) {
          if (event.pointerType !== "touch") setHovered((event.target as Element).closest("[data-channel]")?.getAttribute("data-channel") ?? null);
          return;
        }
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
      }} onPointerLeave={() => setHovered(null)} onPointerCancel={() => { pointers.current.clear(); drag.current = null; }}>
      {showAreas && <g className="community-areas" aria-hidden="true">{areas.map(area =>
        <circle key={area.id} cx={area.x} cy={area.y} r={area.radius} fill={color(area.id)} fillOpacity={0.045} stroke={color(area.id)} strokeOpacity={0.4} vectorEffect="non-scaling-stroke" />
      )}</g>}
      {showConnections && <MapConnections map={visibleMap} selected={selected} dimmed={dimmed} />}
      <g style={{ "--community-unit": `${view.size / mapSide}px` } as CSSProperties}>
        <MapArtwork map={visibleMap} selected={selected} hovered={hovered} dimmed={dimmed} highlighted={highlighted} onHover={setHovered} onSelect={select} />
      </g>
      <MapLabels map={visibleMap} matches={matches} selected={selected} view={view} highlighted={highlighted} areas={areas}
        width={mapSize.width} height={mapSize.height} />
    </svg>

    <div className="community-heading"><h1>Chat communities</h1>
      <p>{formatCount(visibleMap.graph.nodes.length)} of {formatCount(map.graph.nodes.length)} channels shown <span>·</span> {formatCount(communities.length)} communities</p></div>
    <div className="community-date"><strong>30-day map</strong><span>Updated {formatDateTime(map.generatedAt)}</span></div>

    {map.graph.nodes.length === 0 ? <div className="community-empty community-glass"><EmptyState title="Not enough recorded chat activity" description="No channels meet the activity threshold for this reporting window yet." /></div> :
      <section className="community-search community-glass" aria-label="Find a channel">
        <div className="community-search-bar"><span aria-hidden="true">⌕</span>
          <input ref={search} id="community-search" type="search" placeholder="Find a channel…" aria-label="Search channels" value={query}
            onFocus={() => { setSearchOpen(true); setHelpOpen(false); setOptionsOpen(false); setLookupOpen(false); setSelected(null); }}
            onChange={(event) => { setQuery(event.target.value); setPage(0); setSelected(null); setSearchOpen(true); }} />
          <button className="community-icon-button" aria-label={searchOpen ? "Collapse channel search" : "Browse channels"} aria-expanded={searchOpen} aria-controls="community-search-results"
            onClick={() => { setSearchOpen(!searchOpen); setHelpOpen(false); setOptionsOpen(false); setLookupOpen(false); }}>{searchOpen ? "−" : "+"}</button>
        </div>
        <div className="community-search-tools"><button className="community-text-button" aria-expanded={optionsOpen} aria-controls="community-options" onClick={() => { setOptionsOpen(!optionsOpen); setSearchOpen(false); setHelpOpen(false); setLookupOpen(false); }}>Map options</button>
          {canLookupChatter && <button className="community-text-button" aria-expanded={lookupOpen} aria-controls="community-chatter-lookup" onClick={() => {
            setLookupOpen(!lookupOpen); setSearchOpen(false); setOptionsOpen(false); setHelpOpen(false);
            if (!lookupOpen) { setQuery(""); setGroup("all"); setPage(0); }
          }}>Find a chatter</button>}</div>
        {optionsOpen && <section id="community-options" className="community-options" aria-label="Map options">
          <label><input type="checkbox" checked={showConnections} onChange={event => setShowConnections(event.target.checked)} />Show connection lines</label>
          <label><input type="checkbox" checked={showAreas} onChange={event => setShowAreas(event.target.checked)} />Show community category areas</label>
          <p>Circles mark the central area of each community. Labels describe recorded streaming categories, not why people watch.</p>
          {sparseCount > 0 && <label><input type="checkbox" checked={hideSparse} onChange={event => setHideSparse(event.target.checked)} />Hide sparse channels ({formatCount(sparseCount)})</label>}
          {sparseCount > 0 && <p>Sparse means one or two connections on this map. These channels still belong to communities. Searches, chosen communities and connections to the selected channel stay visible.</p>}
        {unconnectedCount > 0 && <label><input type="checkbox" checked={hideUnconnected}
          onChange={(event) => { setHideUnconnected(event.target.checked); setView(event.target.checked ? connectedView : allView); if (event.target.checked && selectedNode?.community == null) setSelected(null); }} />
          Hide unconnected channels ({formatCount(unconnectedCount)})</label>}
        </section>}
        {lookupOpen && canLookupChatter && <ChatterLookup map={map} result={chatter} onResult={result => {
          setChatter(result);
          const nodes = result == null ? [] : result.channels.flatMap(channel => byId.get(channel.channelId) ?? []);
          if (nodes.length > 0) { setSelected(null); setCamera({ selected: null, view: fitCommunityView(nodes) }); }
        }} onSelect={node => select(node, true)} />}
        {chatter != null && !lookupOpen && <div className="community-highlight-status"><span>{chatter.displayName ?? chatter.login}: {chatter.channels.length} highlighted</span><button className="community-text-button" onClick={() => setChatter(null)}>Clear</button></div>}
        {searchOpen && <div id="community-search-results" className="community-search-results">
          <label htmlFor="community-filter">Community</label>
          <select id="community-filter" className="community-input" value={group} onChange={(event) => {
            const next = event.target.value; setGroup(next); setPage(0); setSelected(null);
            const nodes = map.graph.nodes.filter((node) => (node.community ?? "ungrouped") === next);
            if (next === "all") setCamera({ selected: null, view: homeView });
            else if (nodes.length > 0) {
              const xs = nodes.map((node) => node.x), ys = nodes.map((node) => node.y);
              const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
              const size = Math.max(300, Math.max(right - left, bottom - top) * 1.4);
              setCamera({ selected: null, view: { x: (left + right - size) / 2, y: (top + bottom - size) / 2, size } });
            }
          }}><option value="all">All communities</option>
            {communities.map((item) => <option key={item.id} value={item.id}>{labels.get(item.id)} ({item.nodes.length}){categorySummaries.get(item.id) == null ? "" : ` · ${categorySummaries.get(item.id)!.title}`}</option>)}
            <option value="ungrouped">No connections ({unconnectedCount})</option>
          </select>
          <div className="community-list-heading"><span aria-live="polite">{formatCount(matches.length)} {matches.length === 1 ? "channel" : "channels"}</span><span>People</span></div>
          {matches.length === 0 ? <p className="community-no-results">No matching channels. Try another name or community. Some channels may not have enough recorded chat activity yet.</p> :
            <ul className="community-channel-list">{matches.slice(page * 8, page * 8 + 8).map((node) => <li key={node.id}><button onClick={() => select(node, true)} aria-pressed={selected === node.id}>
              <span className="community-color" style={{ background: color(node.community) }} /><span>{name(node)}</span><small>{formatCount(participants(node))}</small>
            </button></li>)}</ul>}
          {matches.length > 8 && <div className="community-pagination"><button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>{page + 1} / {Math.ceil(matches.length / 8)}</span>
            <button disabled={(page + 1) * 8 >= matches.length} onClick={() => setPage(page + 1)}>Next</button></div>}
        </div>}
      </section>}

    {requested.length > 0 && selectedNode == null && <div className="community-details community-glass" role="status"><p>The linked channel is unavailable in this 30-day map. Find another channel or use Fit map to reset.</p></div>}
    {selectedNode != null && <ChannelDetails key={selectedNode.id} node={selectedNode} connections={connections}
      community={communities.find(item => item.id === selectedNode.community)?.nodes ?? []}
      onSelect={node => select(node, true)} onClose={() => { setSelected(null); svg.current?.focus(); }} />}


    <div className="community-bottom-bar"><button className="community-help-button community-glass" aria-expanded={helpOpen} aria-controls="community-explanation" onClick={() => { setHelpOpen(!helpOpen); setSearchOpen(false); setOptionsOpen(false); setLookupOpen(false); }}>How it works <span aria-hidden="true">?</span></button>
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
      <p>Channel names appear wherever they fit without overlapping. Zooming opens more space; off-screen channels do not limit the number of names. Selecting a channel prioritizes its connections without hiding other names.</p>
      <p>Optional category areas are circles around the central 80% of each community, not exact boundaries. Community category descriptions summarize recorded streaming time. A channel mainly streams a category when it accounts for at least 60% of its known category time. “Mostly” requires 60% of channels with category information to share that main category. Mixed categories can reflect variety streamers or different interests within a community; categories do not prove why people move between channels.</p>
      <p>The gray outer ring contains channels with no retained connections. They meet the {thresholds.channelPeople}-person threshold, but no other qualifying channel shares at least {thresholds.sharedPeople} qualifying people with them. Their position is only a way to keep them visible. Map options can hide them. Sparse channels have one or two retained connections and are hidden initially when denser groups exist; they still have a community. Search and chatter highlights can reveal hidden channels.</p>
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
