export type ViewerTrendPoint = {
  time: string;
  viewers: number | null;
  title: string;
};

const width = 800;
const height = 280;
const plot = { left: 58, right: 18, top: 18, bottom: 42 };

export function ViewerTrendChart({ points }: { points: ViewerTrendPoint[] }) {
  const viewerValues = points.flatMap((point) => point.viewers == null ? [] : [point.viewers]);
  if (viewerValues.length === 0) {
    return <p className="muted padded">No chartable viewer snapshots yet.</p>;
  }

  const peakViewers = Math.max(...viewerValues);
  const path = createLinePath(points.map((point) => point.viewers), Math.max(1, peakViewers));
  const first = points[0];
  const last = points.at(-1);

  return (
    <figure className="chart-figure">
      <div className="chart-wrap">
        <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Viewer trend from ${first?.time ?? "the first snapshot"} to ${last?.time ?? "the latest snapshot"}. Peak ${formatNumber(peakViewers)} viewers.`}>
          <g className="chart-grid" aria-hidden="true">
            {[0, 0.5, 1].map((ratio) => {
              const y = plot.top + ratio * (height - plot.top - plot.bottom);
              return <line key={ratio} x1={plot.left} x2={width - plot.right} y1={y} y2={y} />;
            })}
          </g>
          <g className="chart-axis-labels" aria-hidden="true">
            <text x={plot.left - 10} y={plot.top + 4} textAnchor="end">{formatNumber(peakViewers)}</text>
            <text x={plot.left - 10} y={height - plot.bottom + 4} textAnchor="end">0</text>
            <text x={plot.left} y={height - 14}>{first?.time}</text>
            <text x={width - plot.right} y={height - 14} textAnchor="end">{last?.time}</text>
          </g>
          <path className="chart-line chart-line-viewers" d={path} vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <div className="chart-legend" aria-hidden="true"><span><i className="chart-key-viewers" />Viewers</span></div>
      <figcaption className="sr-only">Viewer snapshots over time. Gaps separate distinct stream sessions.</figcaption>
    </figure>
  );
}

function createLinePath(values: Array<number | null>, maxValue: number) {
  const plotWidth = width - plot.left - plot.right;
  const plotHeight = height - plot.top - plot.bottom;
  const divisor = Math.max(1, values.length - 1);
  let path = "";
  let drawing = false;

  values.forEach((value, index) => {
    if (value == null) {
      drawing = false;
      return;
    }

    const x = plot.left + (index / divisor) * plotWidth;
    const y = plot.top + (1 - value / maxValue) * plotHeight;
    path += `${drawing ? " L" : "M"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    drawing = true;
  });

  return path;
}

const formatNumber = (value: number) => new Intl.NumberFormat("en-GB", { notation: value >= 10_000 ? "compact" : "standard" }).format(Math.round(value));
