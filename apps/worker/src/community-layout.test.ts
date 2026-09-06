import { describe, expect, it } from "vitest";
import { UndirectedGraph } from "graphology";
import { communityNodeRadius, type CommunityNode } from "@twitch-tracker/shared";
import { layoutCommunityGraph } from "./community-layout.js";
import { spaceCommunityNodes } from "./community-spacing.js";

describe("Community layout", () => {
  it("separates weakly bridged communities while preserving the graph and circle clearance", () => {
    const graph = new UndirectedGraph();
    const nodes: CommunityNode[] = Array.from({ length: 48 }, (_, i) => ({
      id: String(i), community: String(Math.floor(i / 12)), chatters: 100, x: 0, y: 0
    }));
    nodes.forEach((node, i) => graph.addNode(node.id, { x: Math.cos(i * 2.4) * 100, y: Math.sin(i * 2.4) * 100 }));
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[i]!.community === nodes[j]!.community) graph.addEdge(String(i), String(j), { weight: 0.7 });
    }
    for (let i = 0; i < 3; i++) graph.addEdge(String(i * 12), String((i + 1) * 12), { weight: 0.05 });
    const edges = graph.edges();
    const repeatedGraph = graph.copy(), repeatedNodes = structuredClone(nodes);
    layoutCommunityGraph(graph, nodes);
    spaceCommunityNodes(nodes);
    layoutCommunityGraph(repeatedGraph, repeatedNodes);
    spaceCommunityNodes(repeatedNodes);
    expect(nodes).toEqual(repeatedNodes);
    expect(graph.edges()).toEqual(edges);
    let internal = 0, external = 0, internalCount = 0, externalCount = 0;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!, b = nodes[j]!, distance = Math.hypot(a.x - b.x, a.y - b.y);
      expect(distance).toBeGreaterThan(communityNodeRadius(a.chatters) + communityNodeRadius(b.chatters));
      if (a.community === b.community) { internal += distance; internalCount++; }
      else { external += distance; externalCount++; }
    }
    expect(external / externalCount).toBeGreaterThan(internal / internalCount * 2);
  });

  it("leaves an empty graph for the isolated-node spacing pass", () => {
    const nodes: CommunityNode[] = [{ id: "only", community: null, chatters: 10, x: 500, y: 500 }];
    layoutCommunityGraph(new UndirectedGraph(), nodes);
    expect(nodes[0]).toMatchObject({ x: 500, y: 500 });
  });
});
