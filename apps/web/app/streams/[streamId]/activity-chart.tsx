type ActivityPoint = {
  time: string;
  viewers: number | null;
  messages: number;
  activeChatters: number | null;
};

const width = 800;
const height = 280;
const plot = { left: 58, right: 58, top: 18, bottom: 42 };

export function StreamActivityChart({ points }: { points: ActivityPoint[] }) {
  const viewerValues = points.flatMap((point) => point.viewers == null ? [] : [point.viewers]);
  const chatterValues = points.flatMap((point) => point.activeChatters == null ? [] : [point.activeChatters]);
  const peakMessages = Math.max(0, ...points.map((point) => point.messages));
  const peakChatters = Math.max(0, ...chatterValues);
  if (viewerValues.length === 0 && peakMessages === 0 && peakChatters === 0) {
    return <p className="muted padded">No chartable activity data yet.</p>;
  }

  const peakViewers = viewerValues.length === 0 ? null : Math.max(...viewerValues);
  const maxViewers = Math.max(1, peakViewers ?? 0);
  const maxActivity = Math.max(1, peakMessages, peakChatters);
  const first = points[0];
  const last = points.at(-1);

  return (
    <figure className="chart-figure">
      <div className="chart-wrap">
        <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Stream activity from ${first?.time ?? "the first bucket"} to ${last?.time ?? "the latest bucket"}. ${peakViewers == null ? "No viewer observations" : `Peak ${formatNumber(peakViewers)} viewers`}, ${formatNumber(peakMessages)} messages, and ${formatNumber(peakChatters)} active chatters in a bucket.`}>
          <g className="chart-grid" aria-hidden="true">
            {[0, 0.5, 1].map((ratio) => {
              const y = plot.top + ratio * (height - plot.top - plot.bottom);
              return <line key={ratio} x1={plot.left} x2={width - plot.right} y1={y} y2={y} />;
            })}
          </g>
          <g className="chart-axis-labels" aria-hidden="true">
            <text x={plot.left - 10} y={plot.top + 4} textAnchor="end">{peakViewers == null ? "—" : formatNumber(peakViewers)}</text>
            <text x={width - plot.right + 10} y={plot.top + 4}>{formatNumber(Math.max(peakMessages, peakChatters))}</text>
            <text x={plot.left - 10} y={height - plot.bottom + 4} textAnchor="end">0</text>
            <text x={width - plot.right + 10} y={height - plot.bottom + 4}>0</text>
            <text x={plot.left} y={height - 14}>{first?.time}</text>
            <text x={width - plot.right} y={height - 14} textAnchor="end">{last?.time}</text>
          </g>
          <path className="chart-line chart-line-viewers" d={createLinePath(points.map((point) => point.viewers), maxViewers)} vectorEffect="non-scaling-stroke" />
          <path className="chart-line chart-line-messages" d={createLinePath(points.map((point) => point.messages), maxActivity)} vectorEffect="non-scaling-stroke" />
          <path className="chart-line chart-line-chatters" d={createLinePath(points.map((point) => point.activeChatters), maxActivity)} vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <div className="chart-legend" aria-hidden="true">
        <span><i className="chart-key-viewers" />Viewers</span>
        <span><i className="chart-key-messages" />Messages</span>
        <span><i className="chart-key-chatters" />Active chatters</span>
      </div>
      <figcaption className="sr-only">Viewer snapshots, captured messages, and active chatter estimates over the stream session. Missing observations are shown as gaps.</figcaption>
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
