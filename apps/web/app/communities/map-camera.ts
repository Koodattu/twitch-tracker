export type MapView = { x: number; y: number; size: number };
type Point = { x: number; y: number };
type Bounds = { left: number; top: number; width: number; height: number };

export function fitCommunityView(points: Point[]): MapView {
  if (points.length === 0) return { x: -70, y: -70, size: 1140 };
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  const size = Math.max(1140, right - left + 90, bottom - top + 90);
  return { x: (left + right - size) / 2, y: (top + bottom - size) / 2, size };
}

export function mapPoint(view: MapView, bounds: Bounds, point: Point): Point {
  const side = Math.max(1, Math.min(bounds.width, bounds.height));
  return {
    x: view.x + (point.x - bounds.left - (bounds.width - side) / 2) / side * view.size,
    y: view.y + (point.y - bounds.top - (bounds.height - side) / 2) / side * view.size
  };
}

// Keep the world point beneath the gesture's origin beneath its new screen position.
export function transformCamera(view: MapView, bounds: Bounds, from: Point, to: Point, factor = 1, maxSize = 2200): MapView {
  const anchor = mapPoint(view, bounds, from);
  const next = { ...view, size: Math.min(maxSize, Math.max(100, view.size * factor)) };
  const destination = mapPoint(next, bounds, to);
  return { x: next.x + anchor.x - destination.x, y: next.y + anchor.y - destination.y, size: next.size };
}
