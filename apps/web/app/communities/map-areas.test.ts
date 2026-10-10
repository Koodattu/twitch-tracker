import { describe, expect, it } from "vitest";
import type { CommunityMap } from "@twitch-tracker/shared";
import { communityArea } from "./map-areas";
import { summarizeCommunityCategories } from "./map-categories";
import type { MapNode } from "./map-data";

const node = (id: string, x: number, y: number): MapNode => ({
  id, x, y, community: "group", chatters: 100, login: id, displayName: id, profileImageUrl: null,
  category: { id: "chess", name: "Chess", share: 1 },
});
const edge = (source: string, target: string) => ({ source, target, score: 0.5, shared: 10 });
const clique = (nodes: MapNode[]) => nodes.flatMap((a, index) => nodes.slice(index + 1).map(b => edge(a.id, b.id)));
const core = [node("a", 0, 0), node("b", 10, 0), node("c", 0, 10), node("d", 10, 10)];
const ids = (area: ReturnType<typeof communityArea>) => area?.nodes.map(node => node.id).sort();

describe("Community category areas", () => {
  it("encloses a compact connected core with room for its channel dots", () => {
    const area = communityArea(core, clique(core))!;
    expect(ids(area)).toEqual(["a", "b", "c", "d"]);
    for (const member of core) expect(Math.hypot(member.x - area.x, member.y - area.y) + 9).toBeLessThan(area.radius);
    expect(area.radius).toBeLessThan(35);
  });

  it("does not let unconnected or sparse channels change the circle or its category", () => {
    const fringe = Array.from({ length: 20 }, (_, index) => ({
      ...node(`fringe-${index}`, 1000 + index * 100, 1000),
      category: { id: "music", name: "Music", share: 1 },
    }));
    const nodes = [...core, ...fringe, { ...node("ungrouped", 5000, 5000), community: null }];
    const edges = [...clique(core), ...fringe.slice(0, 12).flatMap(member => [edge(member.id, "a"), edge(member.id, "b")])];
    const area = communityArea(nodes, edges)!;
    expect(area).toEqual(communityArea(core, clique(core)));
    expect(summarizeCommunityCategories(nodes)?.title).toBe("Mostly Music");
    expect(summarizeCommunityCategories(area.nodes)?.title).toBe("Mostly Chess");
  });

  it("peels a high-degree hub supported only by sparse branches", () => {
    const hub = node("hub", 500, 500);
    const leaves = Array.from({ length: 8 }, (_, index) => node(`leaf-${index}`, 500 + index, 510));
    expect(communityArea([hub, ...leaves], leaves.map(leaf => edge(hub.id, leaf.id)))).toBeNull();
  });

  it("does not count other communities as support for a core", () => {
    const outsiders = core.map(member => ({ ...member, community: `other-${member.id}` }));
    expect(communityArea(outsiders, clique(outsiders))).toBeNull();
  });

  it("excludes distant outliers even when they have three community connections", () => {
    const far = node("far", 1000, 1000);
    const edges = [...clique(core), ...core.slice(0, 3).map(member => edge(member.id, far.id))];
    expect(communityArea([...core, far], edges)).toEqual(communityArea(core, clique(core)));
  });

  it("keeps remote dense satellites out instead of bridging clusters", () => {
    const main = [...core, node("e", 5, 5)];
    const satellite = core.map(member => ({ ...member, id: `far-${member.id}`, x: member.x + 1000 }));
    const edges = [...clique(main), ...clique(satellite), edge("a", "far-a")];
    const area = communityArea([...main, ...satellite], edges)!;
    expect(area.nodes.every(member => !member.id.startsWith("far-"))).toBe(true);
    expect(area.radius).toBeLessThan(35);
  });

  it("fits the central half of a larger core without mutating map data", () => {
    const nodes = Array.from({ length: 16 }, (_, index) => node(String(index), index % 4 * 10, Math.floor(index / 4) * 10));
    const edges = clique(nodes);
    const original = structuredClone({ nodes, edges });
    const area = communityArea(nodes, edges)!;
    expect(area.nodes).toHaveLength(8);
    expect(area.radius).toBeLessThan(35);
    expect({ nodes, edges }).toEqual(original);
    expect(communityArea([...nodes].reverse(), [...edges].reverse())).toEqual(area);
  });

  it("omits empty, unconnected and sparse-only communities", () => {
    expect(communityArea([], [])).toBeNull();
    expect(communityArea(core, [])).toBeNull();
    const triangle = core.slice(0, 3);
    expect(communityArea(triangle, clique(triangle))).toBeNull();
    const ring = Array.from({ length: 12 }, (_, index) => node(String(index), index, 0));
    const edges: CommunityMap["graph"]["edges"] = ring.map((member, index) => edge(member.id, ring[(index + 1) % ring.length]!.id));
    expect(communityArea(ring, edges)).toBeNull();
  });
});
