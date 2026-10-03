"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { StreamChartPoint, StreamOverview } from "@twitch-tracker/shared";
import { formatCount, formatDateTime } from "../../format";
import { EmptyState } from "../../ui";
import { readStreamView, streamIntervalQuery, streamViewQuery, type StreamView } from "./stream-view";

const plot = { left: 58, right: 20 };
const laneHeight = 112;
const series = [
  { key: "viewers", label: "Viewers (average / peak)", color: "viewers" },
  { key: "messagesPerMinute", label: "Messages / min", color: "messages" },
  { key: "activeChatters", label: "Peak active chatters", color: "chatters" }
] as const;

export function StreamActivityChart({ activity, streamId }: { activity: StreamOverview; streamId: string }) {
  const { points } = activity;
  const view = readStreamView(useSearchParams());
  const [width, setWidth] = useState(800);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [share, setShare] = useState<{ url: string; copied: boolean } | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const base = `/streams/${encodeURIComponent(streamId)}`;
  const firstTime = Date.parse(points[0]?.time ?? "");
  const lastTime = Date.parse(points.at(-1)?.time ?? "");
  const at = Date.parse(view.at ?? "");
  const validTime = at >= firstTime && at < lastTime + activity.intervalMinutes * 60_000;
  const committedIndex = validTime ? Math.max(0, points.findLastIndex((point) => Date.parse(point.time) <= at)) : 0;
  const intervalIndex = hoverIndex ?? committedIndex;
  const selected = points[intervalIndex];
  const committed = points[committedIndex];
  const lanes = series.filter((item) => view.series.includes(item.key));
  const height = lanes.length * laneHeight + 38;
  const x = (point: StreamChartPoint) => points.length === 1 ? (plot.left + width - plot.right) / 2
    : plot.left + (Date.parse(point.time) - firstTime) / Math.max(1, lastTime - firstTime) * (width - plot.left - plot.right);
  const hasData = points.some((point) => point.viewers != null || point.viewerPeak != null || point.messagesPerMinute != null || point.activeChatters != null);
  const invalid = view.invalid || (view.at != null && !validTime);
  useEffect(() => {
    const element = chartRef.current;
    if (element == null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry != null) setWidth(Math.max(240, entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasData]);

  function update(next: StreamView, replace = false) {
    setHoverIndex(null);
    setShare(null);
    const query = streamViewQuery(next);
    const href = query.size === 0 ? base : `${base}?${query}`;
    if (replace) window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
  }
  function select(index: number, replace = false) {
    const point = points[index];
    if (point != null) update({ ...view, at: new Date(point.time).toISOString() }, replace);
  }
  function focusTime(time: string) {
    const target = Date.parse(time);
    select(Math.max(0, points.findLastIndex((point) => Date.parse(point.time) <= target)));
    chartRef.current?.focus();
  }
  function pointerIndex(event: React.MouseEvent<SVGSVGElement> | React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const targetX = (event.clientX - rect.left) / rect.width * width;
    let index = 0;
    points.forEach((point, candidate) => { if (Math.abs(x(point) - targetX) < Math.abs(x(points[index]!) - targetX)) index = candidate; });
    return index;
  }
  function eventsHref(point: StreamChartPoint) {
    return `${base}/events?${streamIntervalQuery(view, point.time, activity.intervalMinutes)}`;
  }
  async function copyLink() {
    const query = streamViewQuery({ ...view, at: committed == null ? undefined : new Date(committed.time).toISOString() });
    const url = `${window.location.origin}${base}?${query}`;
    try { await navigator.clipboard.writeText(url); setShare({ url, copied: true }); }
    catch { setShare({ url, copied: false }); }
  }
  const highlights = [
    ...(activity.peakAudience == null ? [] : [{ label: "Peak audience", value: `${formatCount(activity.peakAudience.viewers)} viewers`, time: activity.peakAudience.time }]),
    ...(activity.busiestChat == null ? [] : [{ label: "Busiest chat interval", value: `${formatCount(activity.busiestChat.messages)} messages / ${activity.busiestChat.minutes} min`, time: activity.busiestChat.time }]),
    ...(activity.largestRaid == null ? [] : [{ label: "Largest incoming raid", value: `${formatCount(activity.largestRaid.viewers)} viewers`, time: activity.largestRaid.time }])
  ];
  return <>
    <section className="panel">
      <div className="panel-header"><div className="panel-heading"><h2>Activity over time</h2><p>Full observed session · {activity.intervalMinutes}-minute chart intervals · UTC</p></div></div>
      {invalid ? <p className="data-note padded" role="status">The linked time or chart options are unavailable. Showing the available session data; choose an interval to update the link.</p> : null}
      {!hasData ? <EmptyState title="No activity yet" description="The chart will appear when activity observations are available." /> : <figure className="chart-figure">
        <div className="chart-legend stream-chart-controls" role="group" aria-label="Visible metrics">{series.map((item) => <button className="button button-secondary button-compact" type="button" aria-pressed={view.series.includes(item.key)} key={item.key} onClick={() => update({ at: committed == null ? undefined : new Date(committed.time).toISOString(), series: series.filter((candidate) => candidate.key === item.key ? !view.series.includes(item.key) : view.series.includes(candidate.key)).map((candidate) => candidate.key) })}><i className={`chart-key-${item.color}`} aria-hidden="true" />{item.label}</button>)}</div>
        <div className="chart-wrap" ref={chartRef} tabIndex={-1}>
          {lanes.length === 0 ? <EmptyState title="Choose a metric" description="Use the buttons above to show viewers or chat activity. Interval figures remain available below." /> : <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Stream activity on aligned time axes, with a separate scale for each metric. Use the interval slider or interval figures to inspect values."
            onPointerMove={(event) => { if (event.pointerType === "mouse") setHoverIndex(pointerIndex(event)); }} onPointerLeave={() => setHoverIndex(null)} onClick={(event) => select(pointerIndex(event))}>
            {lanes.map((item, lane) => {
              const maximum = Math.max(1, ...points.map((point) => item.key === "viewers" ? Math.max(point.viewers ?? 0, point.viewerPeak ?? 0) : point[item.key] ?? 0));
              const top = lane * laneHeight + 30;
              const bottom = (lane + 1) * laneHeight - 12;
              const y = (value: number) => top + (1 - value / maximum) * (bottom - top);
              function path(key: typeof item.key | "viewerPeak") {
                let drawing = false;
                return points.map((point) => {
                  const value = point[key];
                  if (value == null) { drawing = false; return ""; }
                  if (point.interrupted) drawing = false;
                  const segment = `${drawing ? "L" : "M"} ${x(point).toFixed(2)} ${y(value).toFixed(2)}`;
                  drawing = true;
                  return segment;
                }).join(" ");
              }
              return <g key={item.key}>
                <g className="chart-grid" aria-hidden="true">{[0, 0.5, 1].map((ratio) => <line key={ratio} x1={plot.left} x2={width - plot.right} y1={y(ratio * maximum)} y2={y(ratio * maximum)} />)}</g>
                <g className="chart-axis-labels" aria-hidden="true"><text className="stream-chart-lane-label" x={8} y={lane * laneHeight + 16}>{item.label}</text><text x={plot.left - 10} y={top + 4} textAnchor="end">{formatCount(maximum)}</text><text x={plot.left - 10} y={bottom + 4} textAnchor="end">0</text></g>
                <path className={`chart-line chart-line-${item.color}`} d={path(item.key)} vectorEffect="non-scaling-stroke" />
                {item.key === "viewers" ? <path className="chart-line chart-line-viewers stream-chart-peak" d={path("viewerPeak")} vectorEffect="non-scaling-stroke" /> : null}
                {points.map((point) => <g key={point.time}>
                  {point[item.key] == null ? null : <circle className={`stream-chart-point chart-line-${item.color}`} cx={x(point)} cy={y(point[item.key]!)} r={2} />}
                  {item.key !== "viewers" || point.viewerPeak == null ? null : <circle className="stream-chart-point chart-line-viewers stream-chart-peak" cx={x(point)} cy={y(point.viewerPeak)} r={2} />}
                </g>)}
                {selected == null ? null : <line className="stream-chart-cursor" x1={x(selected)} x2={x(selected)} y1={top} y2={bottom} />}
              </g>;
            })}
            <g className="chart-axis-labels" aria-hidden="true"><text x={8} y={height - 12}>{axisTime(points[0]?.time)}</text><text x={width - 8} y={height - 12} textAnchor="end">{axisTime(points.at(-1)?.time)}</text></g>
          </svg>}
        </div>
        <div className="stream-chart-inspector">
          <label htmlFor="stream-chart-interval">Inspect an interval</label>
          <input id="stream-chart-interval" type="range" min={0} max={Math.max(0, points.length - 1)} value={intervalIndex} onFocus={() => setHoverIndex(null)} onChange={(event) => select(Number(event.target.value), true)} aria-valuetext={formatDateTime(selected?.time)} />
          <div className="stream-chart-values" aria-live={hoverIndex == null ? "polite" : "off"}>
            {selected == null ? null : <><strong>{formatDateTime(selected.time)}</strong><span>{formatCount(selected.viewers)} average / {formatCount(selected.viewerPeak)} peak viewers</span><span>{formatCount(selected.messagesPerMinute)} messages / min</span><span>{formatCount(selected.activeChatters)} peak active chatters</span>{selected.interrupted ? <span className="muted">Missing observations in or before this interval</span> : null}</>}
          </div>
          <div className="stream-inspection-actions">
            {committed == null ? null : <Link className="button button-secondary" href={eventsHref(committed)} prefetch={false}>Events in this interval</Link>}
            <button className="button button-secondary" type="button" onClick={copyLink}>Copy view link</button>
            <button className="button button-secondary" type="button" onClick={() => update({ series: series.map((item) => item.key) })}>Reset view</button>
          </div>
          {share == null ? null : <div className="stream-share-result" role="status">{share.copied ? "View link copied. It includes the selected interval and visible metrics." : <label>Copy this view link<input className="search-input" readOnly value={share.url} onFocus={(event) => event.currentTarget.select()} /></label>}</div>}
        </div>
        <figcaption className="data-note padded">Each metric has its own scale; compare timing across tracks, not line heights. Dashed green shows peak viewers. Click or tap to keep an interval selected. Missing observations remain gaps.</figcaption>
      </figure>}
      {points.length === 0 ? null : <details className="stream-interval-figures"><summary>Interval figures · {points.length} intervals</summary>
        <p className="data-note">Same values and UTC intervals as the chart. A dash means no observation. Active chatters are the maximum distinct speakers in an original activity interval, not unique people across the session. Open a time to inspect its events.</p>
        <div className="table-scroll" role="region" aria-label="Stream interval figures" tabIndex={0}><table className="table table-compact">
          <thead><tr><th scope="col">Interval start (UTC)</th><th scope="col">Avg / peak viewers</th><th scope="col">Messages / min</th><th scope="col">Peak active chatters</th><th scope="col">Observations</th></tr></thead>
          <tbody>{points.map((point) => <tr key={point.time}><th scope="row"><Link href={eventsHref(point)} prefetch={false}>{formatDateTime(point.time)}</Link></th><td className="number-cell">{formatCount(point.viewers)} / {formatCount(point.viewerPeak)}</td><td className="number-cell">{formatCount(point.messagesPerMinute)}</td><td className="number-cell">{formatCount(point.activeChatters)}</td><td>{point.interrupted ? "Gap or partial interval" : "Recorded"}</td></tr>)}</tbody>
        </table></div>
      </details>}
      <p className="data-note padded">Reload to refresh this snapshot. Captured chat can take a few minutes to update; the latest live interval may be partial.</p>
    </section>
    {highlights.length === 0 ? null : <section className="stream-highlights" aria-label="Session highlights">{highlights.map((highlight) => <button className="stream-highlight" type="button" key={highlight.label} onClick={() => focusTime(highlight.time)} disabled={!hasData}>
      <span className="stat-label">{highlight.label}</span><strong>{highlight.value}</strong><span className="stat-detail">{formatDateTime(highlight.time)}</span>
    </button>)}</section>}
  </>;
}

function axisTime(value: string | undefined) {
  return value == null ? "—" : new Date(value).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}
