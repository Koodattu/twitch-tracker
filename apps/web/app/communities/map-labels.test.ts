import { describe, expect, it } from "vitest";
import { placeMapLabels, type LabelCandidate } from "./map-labels";

const node = (id: string, x: number, y: number, audience = 10, priority = 1): LabelCandidate => ({ id, x, y, audience, priority, radius: 8, width: 80 });
describe("Community map label placement", () => {
  it("prioritizes larger channels and reveals smaller nearby names when zoomed in", () => {
    const nodes = [node("small",530,500),node("large",500,500,100)];
    expect(placeMapLabels(nodes,{x:0,y:0,size:1000},1000,1000).map((label) => label.id)).toEqual(["large"]);
    expect(placeMapLabels(nodes,{x:400,y:400,size:200},1000,1000).map((label) => label.id)).toEqual(["large","small"]);
  });
  it("gives selection and hover priority without allowing colliding labels", () => {
    const placed = placeMapLabels([node("big",500,500,1000),node("selected",510,500,10,3),node("hovered",700,500,10,2)],{x:0,y:0,size:1000},1000,1000);
    expect(placed.map((label) => label.id)).toEqual(["selected","hovered"]);
  });
  it("does not spend the label budget on offscreen channels, and includes the wide viewport margins", () => {
    const nodes = Array.from({length:100},(_,i)=>node(`offscreen-${i}`,2000+i*100,2000,1000));
    nodes.push(node("visible",500,500),node("wide-margin",-200,500));
    expect(placeMapLabels(nodes,{x:0,y:0,size:1000},1800,1000).map((label) => label.id)).toEqual(["visible","wide-margin"]);
  });
  it("uses measured text width to keep long channel names apart", () => {
    const nodes = [{...node("long",500,500,100),width:220},node("nearby",630,500),node("distant",800,500)];
    expect(placeMapLabels(nodes,{x:0,y:0,size:1000},1000,1000).map((label) => label.id)).toEqual(["long","distant"]);
  });
});
