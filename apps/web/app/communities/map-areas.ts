import { communityNodeRadius, type CommunityMap } from "@twitch-tracker/shared";
import { participants, type MapNode } from "./map-data";

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

export function communityArea(nodes: MapNode[], edges: CommunityMap["graph"]["edges"]) {
  const byId = new Map(nodes.filter(node => node.community != null).map(node => [node.id, node]));
  const neighbors = new Map([...byId.keys()].map(id => [id, new Set<string>()]));
  for (const edge of edges) {
    const a = byId.get(edge.source), b = byId.get(edge.target);
    if (a == null || b == null || a.community !== b.community || a.id === b.id) continue;
    neighbors.get(a.id)!.add(b.id);
    neighbors.get(b.id)!.add(a.id);
  }

  // Estimate local spacing from each channel's three nearest community connections.
  // Long bridges must not pull separate clusters into a single oversized circle.
  const spacings = [...byId.values()].flatMap(node => {
    const distances = [...neighbors.get(node.id)!].map(id => distance(node, byId.get(id)!)).sort((a, b) => a - b);
    return distances.length < 3 ? [] : [distances[2]!];
  });
  if (spacings.length < 4) return null;
  const maxDistance = median(spacings) * 2;
  for (const [id, adjacent] of neighbors) for (const other of adjacent) {
    if (distance(byId.get(id)!, byId.get(other)!) > maxDistance) adjacent.delete(other);
  }

  // Peel sparse branches repeatedly: connections to excluded channels do not
  // qualify a channel for the core, even when search reveals those channels.
  const pending = [...neighbors.keys()].filter(id => neighbors.get(id)!.size < 3);
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]!, adjacent = neighbors.get(id);
    if (adjacent == null) continue;
    neighbors.delete(id);
    for (const other of adjacent) {
      const remaining = neighbors.get(other);
      if (remaining?.delete(id) && remaining.size < 3) pending.push(other);
    }
  }

  // Use the largest connected core; audience only breaks equally sized ties.
  const visited = new Set<string>();
  const components: MapNode[][] = [];
  for (const id of [...neighbors.keys()].sort()) {
    if (visited.has(id)) continue;
    const component = [byId.get(id)!];
    visited.add(id);
    for (let index = 0; index < component.length; index++) {
      for (const other of neighbors.get(component[index]!.id)!) if (!visited.has(other)) {
        visited.add(other);
        component.push(byId.get(other)!);
      }
    }
    components.push(component);
  }
  const audience = (component: MapNode[]) => component.reduce((sum, node) => sum + participants(node), 0);
  const core = components.sort((a, b) => b.length - a.length || audience(b) - audience(a))[0];
  if (core == null) return null;

  // Mark only the central half of the core, with enough padding for the dots.
  const center = { x: median(core.map(node => node.x)), y: median(core.map(node => node.y)) };
  const members = core.sort((a, b) => distance(a, center) - distance(b, center) || a.id.localeCompare(b.id))
    .slice(0, Math.max(4, Math.ceil(core.length / 2)));
  const x = median(members.map(node => node.x)), y = median(members.map(node => node.y));
  const radius = Math.max(...members.map(node => distance(node, { x, y }) + communityNodeRadius(participants(node)))) + 6;
  return { x, y, radius, nodes: members };
}
