import type { CommunityMap } from "@twitch-tracker/shared";

export type MapNode = CommunityMap["graph"]["nodes"][number];
export type MapConnection = CommunityMap["graph"]["edges"][number] & { node: MapNode };
export const participants = (node: MapNode) => node.participants ?? node.chatters;
export const channelName = (node: MapNode) => node.displayName ?? node.login ?? "Unnamed channel";
export function communityColor(id: string | null) {
  if (id == null) return "#a7a1b4";
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 78% 68%)`;
}

export function connectionCounts(map: CommunityMap) {
  const counts = new Map(map.graph.nodes.map(node => [node.id, 0]));
  for (const edge of map.graph.edges) {
    counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
  }
  return counts;
}

export function communityArea(nodes: MapNode[]) {
  if (nodes.length < 3) return null;
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const x = median(nodes.map(node => node.x)), y = median(nodes.map(node => node.y));
  const distances = nodes.map(node => Math.hypot(node.x - x, node.y - y)).sort((a, b) => a - b);
  // A guide to the central 80%, not a boundary or a claim that outliers are unrelated.
  return { x, y, radius: Math.max(30, distances[Math.ceil(distances.length * 0.8) - 1]! + 20) };
}
