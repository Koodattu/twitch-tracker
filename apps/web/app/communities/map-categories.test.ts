import { describe, expect, it } from "vitest";
import { summarizeCommunityCategories } from "./map-categories";
import type { CommunityNode } from "@twitch-tracker/shared";

const node = (id: string, name: string, share = 1): CommunityNode => ({ id, chatters: 10, community: "group", x: 0, y: 0, category: { id: name, name, share } });
describe("Community category descriptions", () => {
  it("describes a majority without letting one large channel dominate", () => {
    const nodes = [node("a","World of Warcraft"),node("b","World of Warcraft"),{...node("c","Just Chatting"),chatters:100000}];
    expect(summarizeCommunityCategories(nodes)).toMatchObject({ title: "Mostly World of Warcraft", known: 3, categories: [{name:"World of Warcraft",channels:2},{name:"Just Chatting",channels:1}] });
  });
  it("keeps mixed communities mixed, and does not assign split-category channels a main game", () => {
    expect(summarizeCommunityCategories([node("a","WoW",0.4),node("b","Chess",0.5),node("c","Music")])).toMatchObject({ title: "Mixed categories", mixed: 2, categories: [{name:"Music",channels:1}] });
  });
  it("does not label a community from sparse category coverage or too few channels", () => {
    expect(summarizeCommunityCategories([node("a","Chess"),node("b","Chess")])).toBeNull();
    const unknown: CommunityNode = { id: "unknown",chatters:10,community:"group",x:0,y:0 };
    expect(summarizeCommunityCategories([node("a","Chess"),node("b","Chess"),node("c","Chess"),unknown,unknown,unknown,unknown])).toBeNull();
  });
});
