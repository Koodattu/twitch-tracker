import type { UndirectedGraph } from "graphology";
import forceAtlas2Module from "graphology-layout-forceatlas2";
import { communityNodeRadius, type CommunityNode } from "@twitch-tracker/shared";

const forceAtlas2 = forceAtlas2Module as unknown as typeof forceAtlas2Module.default;

export function layoutCommunityGraph(graph: UndirectedGraph, nodes: CommunityNode[]) {
  if (graph.order === 0) return;
  forceAtlas2.assign(graph, { iterations: 1200, getEdgeWeight: "weight",
    settings: { linLogMode: true, strongGravityMode: false, gravity: 0.5,
      scalingRatio: 10, slowDown: 5, barnesHutOptimize: true } });
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  graph.forEachNode((_id, point) => {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  });
  const active = nodes.filter((node) => node.community != null);
  const area = active.reduce((sum, node) => sum + Math.PI * Math.pow(communityNodeRadius(node.participants ?? node.chatters) + 3, 2), 0);
  // Budget room for the circles before collision removal, preserving gaps in the force layout.
  const targetSpan = Math.max(800, Math.sqrt(area / 0.12));
  const scale = targetSpan / Math.max(maxX - minX, maxY - minY, 1);
  for (const node of active) {
    const point = graph.getNodeAttributes(node.id);
    node.x = 500 + (point.x - (minX + maxX) / 2) * scale;
    node.y = 500 + (point.y - (minY + maxY) / 2) * scale;
  }
}
