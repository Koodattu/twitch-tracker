import { describe, expect, it } from "vitest";
import { communityNodeRadius, type CommunityNode } from "@twitch-tracker/shared";
import { spaceCommunityNodes } from "./community-spacing.js";

const node = (id: number, community: string | null, x = 500, y = 500): CommunityNode => ({
  id: String(id), community, x, y, chatters: 0, participants: id % 3 === 0 ? 1000 : 10
});
function expectSeparated(nodes: CommunityNode[]) {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i]!, b = nodes[j]!;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(
      communityNodeRadius(a.participants ?? a.chatters) + communityNodeRadius(b.participants ?? b.chatters)
    );
  }
}

describe("Community circle spacing", () => {
  it("separates a dense pile of different sizes deterministically without scattering distant communities", () => {
    const input = Array.from({ length: 100 }, (_, i) => node(i, "a"));
    input.push(node(100, "b", 1500, 1500));
    const first = structuredClone(input), second = structuredClone(input).reverse();
    const result = spaceCommunityNodes(first);
    spaceCommunityNodes(second);
    expectSeparated(first);
    expect(first).toEqual(second.reverse());
    expect(result.spacingExpansion).toBeLessThan(1.2);
    expect(Math.hypot(first[100]!.x - 1500, first[100]!.y - 1500)).toBeLessThan(10);
    expect(Math.max(...first.slice(0, 100).map((n) => Math.hypot(n.x - 500, n.y - 500)))).toBeLessThan(300);
  });

  it("gives a crowded outer ring enough circumference and clears connected circles", () => {
    const nodes = [node(0, "a", 900, 900), ...Array.from({ length: 500 }, (_, i) => node(i + 1, null))];
    spaceCommunityNodes(nodes);
    expectSeparated(nodes);
  });

  it("handles an empty map and a single unconnected channel", () => {
    spaceCommunityNodes([]);
    const nodes = [node(1, null)];
    spaceCommunityNodes(nodes);
    expect(Number.isFinite(nodes[0]!.x + nodes[0]!.y)).toBe(true);
  });
});
