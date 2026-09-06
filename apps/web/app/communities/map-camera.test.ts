import { describe, expect, it } from "vitest";
import { fitCommunityView, mapPoint, transformCamera } from "./map-camera";

const view = { x: 0, y: 0, size: 1000 };
const bounds = { left: 20, top: 80, width: 1400, height: 800 };

describe("Community map gestures", () => {
  it("fits expanded layouts and permits zooming out past their full extent", () => {
    const fit = fitCommunityView([{ x: -1200, y: -400 }, { x: 2200, y: 2100 }]);
    expect(fit.x).toBeLessThan(-1200);
    expect(fit.y).toBeLessThan(-400);
    expect(fit.x + fit.size).toBeGreaterThan(2200);
    expect(fit.y + fit.size).toBeGreaterThan(2100);
    expect(transformCamera(fit, bounds, { x: 500, y: 500 }, { x: 500, y: 500 }, 2, fit.size * 2).size).toBe(fit.size * 2);
    expect(fitCommunityView([])).toEqual({ x: -70, y: -70, size: 1140 });
  });
  it("zooms around the cursor in a letterboxed viewport", () => {
    const cursor = { x: 540, y: 310 };
    const next = transformCamera(view, bounds, cursor, cursor, 0.5);
    expect(next.size).toBe(500);
    expect(mapPoint(next, bounds, cursor)).toEqual(mapPoint(view, bounds, cursor));
  });

  it("combines pinch zoom and pan without moving the point under the fingers", () => {
    const from = { x: 720, y: 480 }, to = { x: 800, y: 520 };
    const next = transformCamera(view, bounds, from, to, 0.8);
    expect(mapPoint(next, bounds, to)).toEqual(mapPoint(view, bounds, from));
    expect(transformCamera(view, bounds, from, to)).toEqual({ x: -100, y: -50, size: 1000 });
  });

  it("preserves the cursor anchor at both zoom limits and on portrait screens", () => {
    const portrait = { left: 0, top: 110, width: 390, height: 700 };
    const cursor = { x: 150, y: 380 };
    for (const [factor, size] of [[0.001, 100], [100, 2200]]) {
      const next = transformCamera(view, portrait, cursor, cursor, factor);
      expect(next.size).toBe(size);
      const before = mapPoint(view, portrait, cursor), after = mapPoint(next, portrait, cursor);
      expect(after.x).toBeCloseTo(before.x);
      expect(after.y).toBeCloseTo(before.y);
    }
  });
});
