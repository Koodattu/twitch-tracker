import { createHash } from "node:crypto";
import { UndirectedGraph } from "graphology";
import louvainModule from "graphology-communities-louvain";
import forceAtlas2Module from "graphology-layout-forceatlas2";
import type { CommunityEdge, CommunityGraph, CommunityNode } from "@twitch-tracker/shared";

// These CommonJS packages declare their callable module.exports as ESM defaults.
const louvain = louvainModule as unknown as typeof louvainModule.default;
const forceAtlas2 = forceAtlas2Module as unknown as typeof forceAtlas2Module.default;

export const maxCommunityMemberships = 500_000;
export type CommunityGraphInput = { memberships: Array<{ chatterId: string; channelId: string; weight?: number }>; previous: CommunityGraph | null };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function buildCommunityGraph({ memberships, previous }: CommunityGraphInput) {
  if (memberships.length > maxCommunityMemberships) throw new Error("Community membership budget exceeded");
  const audiences = new Map<string, Map<string, number>>();
  for (const { chatterId, channelId, weight = 1 } of memberships) {
    if (weight !== 1 && weight !== 0.25) throw new Error("Invalid community membership weight");
    if (!audiences.has(channelId)) audiences.set(channelId, new Map());
    audiences.get(channelId)!.set(chatterId, Math.max(weight, audiences.get(channelId)!.get(chatterId) ?? 0));
  }
  const channels = [...audiences.keys()].filter((id) => audiences.get(id)!.size >= 10).sort(compare);
  if (channels.length > 10_000) throw new Error("Community channel budget exceeded");
  const visits = new Map<string, string[]>();
  for (const id of channels) for (const chatter of audiences.get(id)!.keys()) {
    if (!visits.has(chatter)) visits.set(chatter, []);
    visits.get(chatter)!.push(id);
  }
  const counts = new Map<string, { shared: number; weighted: number }>();
  let pairContributions = 0;
  let maxChannelsPerChatter = 0;
  for (const [chatter, ids] of visits) {
    maxChannelsPerChatter = Math.max(maxChannelsPerChatter, ids.length);
    pairContributions += ids.length * (ids.length - 1) / 2;
    if (pairContributions > 10_000_000) throw new Error("Community pair budget exceeded");
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const key = `${ids[i]}\0${ids[j]}`;
      const count = counts.get(key) ?? { shared: 0, weighted: 0 };
      count.shared++;
      count.weighted += Math.min(audiences.get(ids[i]!)!.get(chatter)!, audiences.get(ids[j]!)!.get(chatter)!);
      counts.set(key, count);
      if (counts.size > 1_000_000) throw new Error("Community edge budget exceeded");
    }
  }
  const candidates: CommunityEdge[] = [];
  for (const [key, { shared, weighted }] of counts) {
    if (shared < 5) continue;
    const [source, target] = key.split("\0") as [string, string];
    candidates.push({ source, target, shared, score: weighted / Math.sqrt(audiences.get(source)!.size * audiences.get(target)!.size) });
  }
  candidates.sort((a, b) => b.score - a.score || b.shared - a.shared || compare(a.source, b.source) || compare(a.target, b.target));
  const ranks = new Map<string, number>();
  const edges = candidates.filter(({ source, target }) => {
    const a = ranks.get(source) ?? 0;
    const b = ranks.get(target) ?? 0;
    ranks.set(source, a + 1);
    ranks.set(target, b + 1);
    return a < 10 || b < 10;
  });
  const connected = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const graph = new UndirectedGraph();
  const oldNodes = new Map(previous?.nodes.map((node) => [node.id, node]));
  const active = channels.filter((id) => connected.has(id));
  active.forEach((id, index) => {
    const old = oldNodes.get(id);
    const angle = index * 2 * Math.PI / active.length;
    graph.addNode(id, { x: old == null ? Math.cos(angle) * 100 : (old.x - 500) / 4,
      y: old == null ? Math.sin(angle) * 100 : (old.y - 500) / 4 });
  });
  for (const edge of edges) graph.addEdge(edge.source, edge.target, { weight: edge.score });
  const partition = graph.size === 0 ? {} : louvain(graph, { randomWalk: false, getEdgeWeight: "weight" });
  const groups = new Map<number, string[]>();
  for (const id of active) {
    const group = partition[id]!;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(id);
  }
  const clusters = [...groups.values()].sort((a, b) => compare(a[0]!, b[0]!));
  const communityIds = new Map<string, string>();
  const matches: Array<{ group: number; old: string; overlap: number }> = [];
  clusters.forEach((ids, group) => {
    const overlaps = new Map<string, number>();
    for (const id of ids) {
      const old = oldNodes.get(id)?.community;
      if (old != null) overlaps.set(old, (overlaps.get(old) ?? 0) + 1);
    }
    for (const [old, overlap] of overlaps) matches.push({ group, old, overlap });
  });
  matches.sort((a, b) => b.overlap - a.overlap || a.group - b.group || compare(a.old, b.old));
  const assigned = new Map<number, string>();
  const used = new Set<string>();
  for (const match of matches) if (!assigned.has(match.group) && !used.has(match.old)) {
    assigned.set(match.group, match.old);
    used.add(match.old);
  }
  clusters.forEach((ids, group) => {
    let id = assigned.get(group) ?? `community-${createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 16)}`;
    if (!assigned.has(group) && used.has(id)) id += `-${group}`;
    used.add(id);
    ids.forEach((channel) => communityIds.set(channel, id));
  });
  if (graph.size > 0) forceAtlas2.assign(graph, { iterations: 250, getEdgeWeight: "weight",
    settings: { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: true, gravity: 1, slowDown: 5 } });
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  graph.forEachNode((_id, attributes) => {
    minX = Math.min(minX, attributes.x); maxX = Math.max(maxX, attributes.x);
    minY = Math.min(minY, attributes.y); maxY = Math.max(maxY, attributes.y);
  });
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const isolated = channels.filter((id) => !connected.has(id));
  const isolateIndex = new Map(isolated.map((id, index) => [id, index]));
  const nodes: CommunityNode[] = channels.map((id) => {
    const point = connected.has(id) ? graph.getNodeAttributes(id) : null;
    const angle = (isolateIndex.get(id) ?? 0) * 2 * Math.PI / Math.max(isolated.length, 1);
    const x = point == null ? 500 + Math.cos(angle) * 465 : 500 + (point.x - (minX + maxX) / 2) / span * 800;
    const y = point == null ? 500 + Math.sin(angle) * 465 : 500 + (point.y - (minY + maxY) / 2) / span * 800;
    return { id, chatters: [...audiences.get(id)!.values()].filter((weight) => weight === 1).length,
      participants: audiences.get(id)!.size, community: communityIds.get(id) ?? null,
      x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
  });
  const result = { nodes, edges };
  if (nodes.some((node) => !Number.isFinite(node.x) || !Number.isFinite(node.y))) throw new Error("Invalid community layout");
  if (Buffer.byteLength(JSON.stringify(result)) > 10_000_000) throw new Error("Community snapshot budget exceeded");
  return { graph: result, diagnostics: { pairContributions, maxChannelsPerChatter, candidateEdges: candidates.length } };
}
