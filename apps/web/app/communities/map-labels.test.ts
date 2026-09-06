import { describe, expect, it } from "vitest";
import { placeMapLabels, type LabelCandidate } from "./map-labels";

const node = (id: string, x: number, y: number, audience = 10, priority = 1): LabelCandidate => ({ id, x, y, audience, priority, radius: 8, width: 80 });
describe("Community map label placement", () => {
  it("prioritizes larger channels and reveals smaller nearby names when zoomed in", () => {
    const nodes = [node("small",530,500),node("large",500,500,100)];
    expect(placeMapLabels(nodes,{x:0,y:0,size:1000},1000,1000).map((label) => label.id)).toEqual(["large"]);
    expect(placeMapLabels(nodes,{x:400,y:400,size:200},1000,1000).map((label) => label.id)).toEqual(["large","small"]);
  });
  it("gives selection priority without allowing colliding labels", () => {
    const placed = placeMapLabels([node("big",500,500,1000),node("selected",510,500,10,3),node("neighbor",700,500)],{x:0,y:0,size:1000},1000,1000);
    expect(placed.map((label) => label.id)).toEqual(["selected","neighbor"]);
  });
  it("clips labels to the viewport including its wide margins", () => {
    const nodes = [node("offscreen",2000,2000),node("visible",500,500),node("wide-margin",-200,500)];
    expect(placeMapLabels(nodes,{x:0,y:0,size:1000},1800,1000).map((label) => label.id)).toEqual(["visible","wide-margin"]);
  });
  it("does not promote labels when higher ranked channels leave the viewport during a pan", () => {
    const nodes = Array.from({length:14},(_,i)=>node(`large-${i}`,100+i*140,100,1000));
    nodes.push(node("small",800,700));
    for (const x of [0,200,400,600]) {
      expect(placeMapLabels(nodes,{x,y:0,size:1140},1000,1000).some((label)=>label.id === "small")).toBe(false);
    }
  });
  it("keeps a colliding smaller label hidden when its larger competitor crosses a viewport boundary", () => {
    const nodes = [node("large",100,500,1000),node("small",180,500)];
    expect(placeMapLabels(nodes,{x:0,y:0,size:1000},1000,1000).map(label=>label.id)).toEqual(["large"]);
    expect(placeMapLabels(nodes,{x:150,y:0,size:1000},1000,1000)).toEqual([]);
  });
  it("uses measured text width to keep long channel names apart", () => {
    const nodes = [{...node("long",500,500,100),width:220},node("nearby",630,500),node("distant",800,500)];
    expect(placeMapLabels(nodes,{x:0,y:0,size:1000},1000,1000).map((label) => label.id)).toEqual(["long","distant"]);
  });
});
