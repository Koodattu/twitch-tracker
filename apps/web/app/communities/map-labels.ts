import { mapPoint, type MapView } from "./map-camera";

export type LabelCandidate = { id: string; x: number; y: number; radius: number; width: number; audience: number; priority: number };

// Work in map coordinates, but keep label spacing and text size constant on screen.
export function placeMapLabels(candidates: LabelCandidate[], view: MapView, width: number, height: number, referenceSize = 1140) {
  const unit = view.size / Math.max(1, Math.min(width, height));
  const bounds = { left: 0, top: 0, width, height };
  const topLeft = mapPoint(view, bounds, { x: 0, y: 0 });
  const bottomRight = mapPoint(view, bounds, { x: width, y: height });
  const limit = Math.min(160, Math.ceil((width < 760 ? 6 : 14) * Math.pow(referenceSize / view.size, 1.3)));
  const placed: Array<{ id: string; x: number; y: number; halfWidth: number }> = [];
  for (const node of [...candidates].sort((a, b) => b.priority - a.priority || b.audience - a.audience || a.id.localeCompare(b.id))) {
    if (placed.length >= limit) break;
    const y = node.y - Math.min(node.radius, 18 * unit) - 7 * unit;
    const halfWidth = (node.width / 2 + 5) * unit;
    if (node.x + halfWidth < topLeft.x || node.x - halfWidth > bottomRight.x || y < topLeft.y || y - 14 * unit > bottomRight.y) continue;
    if (placed.some((label) => Math.abs(label.x - node.x) < label.halfWidth + halfWidth && Math.abs(label.y - y) < 19 * unit)) continue;
    placed.push({ id: node.id, x: node.x, y, halfWidth });
  }
  return placed;
}
