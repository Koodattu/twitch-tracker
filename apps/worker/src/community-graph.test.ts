import { describe, expect, it } from "vitest";
import { buildCommunityGraph } from "./community-graph.js";
import { runGraphThread } from "./loops/community-map.js";

const audience = (channelId: string, start: number, count: number) => Array.from({ length: count }, (_, index) => ({ channelId, chatterId: `user-${index + start}` }));

describe("Community graph", () => {
  it("counts distinct people, normalizes overlap, and retains isolated qualifying channels", () => {
    const memberships = [...audience("a", 0, 10), ...audience("b", 5, 20), ...audience("c", 100, 10), ...audience("small", 0, 9)];
    const { graph } = buildCommunityGraph({ memberships: [...memberships, ...memberships], previous: null });
    expect(graph.nodes.map(({ id, chatters }) => ({ id, chatters }))).toEqual([{ id: "a", chatters: 10 }, { id: "b", chatters: 20 }, { id: "c", chatters: 10 }]);
    expect(graph.edges).toEqual([{ source: "a", target: "b", shared: 5, score: 5 / Math.sqrt(200) }]);
    expect(graph.nodes[0]!.community).toBe(graph.nodes[1]!.community);
    expect(graph.nodes[2]!.community).toBeNull();
    expect(JSON.stringify(graph)).not.toContain("user-");
  });

  it("omits weak overlaps and bounds the retained graph by the union of strongest neighbors", () => {
    const memberships = Array.from({ length: 25 }, (_, index) => audience(`channel-${String(index).padStart(2, "0")}`, 0, 10)).flat();
    const { graph } = buildCommunityGraph({ memberships, previous: null });
    expect(graph.edges.length).toBeLessThanOrEqual(10 * graph.nodes.length);
    for (const node of graph.nodes) expect(graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id).length).toBeGreaterThanOrEqual(10);
    const weak = buildCommunityGraph({ memberships: [...audience("a", 0, 10), ...audience("b", 6, 10)], previous: null });
    expect(weak.graph.edges).toHaveLength(0);
  });

  it("detects dense communities connected by a bridge and produces reproducible positions", () => {
    const memberships = ["a", "b", "c"].flatMap((id) => audience(id, 0, 40))
      .concat(["d", "e", "f"].flatMap((id) => audience(id, 100, 40)), audience("c", 200, 5), audience("d", 200, 5));
    const first = buildCommunityGraph({ memberships, previous: null });
    const again = buildCommunityGraph({ memberships: [...memberships].reverse(), previous: null });
    expect(first.graph).toEqual(again.graph);
    expect(first.graph.nodes[0]!.community).not.toBe(first.graph.nodes[5]!.community);
    const next = buildCommunityGraph({ memberships, previous: first.graph });
    expect(next.graph.nodes.map((node) => node.community)).toEqual(first.graph.nodes.map((node) => node.community));
  });

  it("executes the graph in a real worker thread and handles an empty graph", async () => {
    const result = await runGraphThread({ memberships: [], previous: null }, AbortSignal.timeout(15_000));
    expect(result.graph).toEqual({ nodes: [], edges: [] });
  });

  it("rejects inputs exceeding the budget instead of publishing a truncated map", () => {
    const memberships = Array.from({ length: 500_001 }, () => ({ channelId: "a", chatterId: "user" }));
    expect(() => buildCommunityGraph({ memberships, previous: null })).toThrow("Community membership budget exceeded");
  });
});
