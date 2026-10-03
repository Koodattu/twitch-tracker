import { mapPoint, type MapView } from "./map-camera";

export type LabelCandidate = { id: string; x: number; y: number; radius: number; width: number; audience: number; priority: number };

// Work in map coordinates, but keep label spacing and text size constant on screen.
export function placeMapLabels(candidates: LabelCandidate[], view: MapView, width: number, height: number) {
  const unit = view.size / Math.max(1, Math.min(width, height));
  const bounds = { left: 0, top: 0, width, height };
  const topLeft = mapPoint(view, bounds, { x: 0, y: 0 });
  const bottomRight = mapPoint(view, bounds, { x: width, y: height });
  const placed: Array<{ id: string; x: number; y: number; halfWidth: number }> = [];
  const cells = new Map<string, typeof placed>();
  const cellKeys = (x: number, y: number, halfWidth: number) => {
    const keys: string[] = [];
    for (let column = Math.floor((x - halfWidth) / (128 * unit)); column <= Math.floor((x + halfWidth) / (128 * unit)); column++) {
      for (let row = Math.floor((y - 19 * unit) / (24 * unit)); row <= Math.floor(y / (24 * unit)); row++) keys.push(`${column}:${row}`);
    }
    return keys;
  };
  for (const node of [...candidates].sort((a, b) => b.priority - a.priority || b.audience - a.audience || a.id.localeCompare(b.id))) {
    const y = node.y - Math.min(node.radius, 18 * unit) - 7 * unit;
    const halfWidth = (node.width / 2 + 5) * unit;
    const keys = cellKeys(node.x, y, halfWidth);
    if (keys.some((key) => cells.get(key)?.some((label) => Math.abs(label.x - node.x) < label.halfWidth + halfWidth && Math.abs(label.y - y) < 19 * unit))) continue;
    const label = { id: node.id, x: node.x, y, halfWidth };
    placed.push(label);
    for (const key of keys) {
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key)!.push(label);
    }
  }
  // Choose labels for the whole graph before clipping. Panning must not promote a
  // different label when a competing name leaves the viewport. There is no global
  // count limit: off-screen channels must not consume the visible area's labels.
  return placed.filter((label) => label.x + label.halfWidth >= topLeft.x && label.x - label.halfWidth <= bottomRight.x &&
    label.y >= topLeft.y && label.y - 14 * unit <= bottomRight.y);
}
