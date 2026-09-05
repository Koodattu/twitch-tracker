"use client";

import { useRef, useState } from "react";
import type { StreamChartPoint, StreamOverview } from "@twitch-tracker/shared";
import { formatCount, formatDateTime } from "../../format";
import { EmptyState } from "../../ui";

const width = 800;
const height = 280;
const plot = { left: 58, right: 58, top: 18, bottom: 42 };
const series = [
  { key: "viewers", label: "Viewers (average / peak)", color: "viewers" },
  { key: "messagesPerMinute", label: "Messages / min", color: "messages" },
  { key: "activeChatters", label: "Peak active chatters", color: "chatters" }
] as const;

export function StreamActivityChart({ activity }: { activity: StreamOverview }) {
  const { points } = activity;
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [visible, setVisible] = useState({ viewers: true, messagesPerMinute: true, activeChatters: true });
  const chartRef = useRef<HTMLDivElement>(null);
  const selected = selectedIndex == null ? null : points[selectedIndex];
  const firstTime = new Date(points[0]?.time ?? 0).getTime();
  const lastTime = new Date(points.at(-1)?.time ?? 0).getTime();
  const x = (point: StreamChartPoint) => plot.left + (new Date(point.time).getTime() - firstTime) / Math.max(1, lastTime - firstTime) * (width - plot.left - plot.right);
  const viewerMax = Math.max(1, ...points.map((point) => point.viewerPeak ?? point.viewers ?? 0));
  const activityMax = Math.max(1, ...points.map((point) => Math.max(visible.messagesPerMinute ? point.messagesPerMinute ?? 0 : 0, visible.activeChatters ? point.activeChatters ?? 0 : 0)));
  const hasData = points.some((point) => point.viewers != null || point.messagesPerMinute != null || point.activeChatters != null);
  function path(key: "viewers" | "viewerPeak" | "messagesPerMinute" | "activeChatters", max: number) {
    let drawing = false;
    return points.map((point) => {
      const value = point[key];
      if (value == null) { drawing = false; return ""; }
      if (point.interrupted) drawing = false;
      const y = plot.top + (1 - value / max) * (height - plot.top - plot.bottom);
      const segment = `${drawing ? "L" : "M"} ${x(point).toFixed(2)} ${y.toFixed(2)}`;
      drawing = true;
      return segment;
    }).join(" ");
  }
  function focusTime(time: string) {
    const target = new Date(time).getTime();
    let index = 0;
    points.forEach((point, candidate) => { if (new Date(point.time).getTime() <= target) index = candidate; });
    setSelectedIndex(index);
    chartRef.current?.focus();
  }
  const highlights = [
    ...(activity.peakAudience == null ? [] : [{ label: "Peak audience", value: `${formatCount(activity.peakAudience.viewers)} viewers`, time: activity.peakAudience.time }]),
    ...(activity.busiestChat == null ? [] : [{ label: "Busiest chat interval", value: `${formatCount(activity.busiestChat.messages)} messages / ${activity.busiestChat.minutes} min`, time: activity.busiestChat.time }]),
    ...(activity.largestRaid == null ? [] : [{ label: "Largest incoming raid", value: `${formatCount(activity.largestRaid.viewers)} viewers`, time: activity.largestRaid.time }])
  ];
  return <>
    <section className="panel">
      <div className="panel-header"><div className="panel-heading"><h2>Activity over time</h2><p>Full observed session · {activity.intervalMinutes}-minute chart intervals · UTC</p></div></div>
      {!hasData ? <EmptyState title="No activity yet" description="The chart will appear when activity observations are available." /> : <figure className="chart-figure">
        <div className="chart-legend stream-chart-controls">{series.map((item) => <button className="button button-secondary button-compact" type="button" aria-pressed={visible[item.key]} key={item.key} onClick={() => setVisible({ ...visible, [item.key]: !visible[item.key] })}><i className={`chart-key-${item.color}`} />{item.label}</button>)}</div>
        <div className="chart-wrap" ref={chartRef} tabIndex={-1}>
          <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Stream activity. Use the interval slider below to inspect values." onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const targetX = (event.clientX - rect.left) / rect.width * width;
            let index = 0;
            points.forEach((point, candidate) => { if (Math.abs(x(point) - targetX) < Math.abs(x(points[index]!) - targetX)) index = candidate; });
            setSelectedIndex(index);
          }}>
            <g className="chart-grid" aria-hidden="true">{[0, 0.5, 1].map((ratio) => <line key={ratio} x1={plot.left} x2={width - plot.right} y1={plot.top + ratio * (height - plot.top - plot.bottom)} y2={plot.top + ratio * (height - plot.top - plot.bottom)} />)}</g>
            <g className="chart-axis-labels" aria-hidden="true">
              <text x={plot.left - 10} y={plot.top + 4} textAnchor="end">{visible.viewers ? formatCount(viewerMax) : "—"}</text>
              <text x={width - plot.right + 10} y={plot.top + 4}>{visible.messagesPerMinute || visible.activeChatters ? formatCount(activityMax) : "—"}</text>
              <text x={plot.left - 10} y={height - plot.bottom + 4} textAnchor="end">0</text><text x={width - plot.right + 10} y={height - plot.bottom + 4}>0</text>
              <text x={plot.left} y={height - 14}>{axisTime(points[0]?.time)}</text><text x={width - plot.right} y={height - 14} textAnchor="end">{axisTime(points.at(-1)?.time)}</text>
            </g>
            {series.filter((item) => visible[item.key]).map((item) => <g key={item.key}>
              <path className={`chart-line chart-line-${item.color}`} d={path(item.key, item.key === "viewers" ? viewerMax : activityMax)} vectorEffect="non-scaling-stroke" />
              {points.map((point) => point[item.key] == null ? null : <circle key={point.time} className={`stream-chart-point chart-line-${item.color}`} cx={x(point)} cy={plot.top + (1 - point[item.key]! / (item.key === "viewers" ? viewerMax : activityMax)) * (height - plot.top - plot.bottom)} r={1.8} />)}
            </g>)}
            {visible.viewers ? <path className="chart-line chart-line-viewers stream-chart-peak" d={path("viewerPeak", viewerMax)} vectorEffect="non-scaling-stroke" /> : null}
            {selected == null ? null : <line className="stream-chart-cursor" x1={x(selected)} x2={x(selected)} y1={plot.top} y2={height - plot.bottom} />}
          </svg>
        </div>
        <div className="stream-chart-inspector">
          <label htmlFor="stream-chart-interval">Inspect an interval</label>
          <input id="stream-chart-interval" type="range" min={0} max={Math.max(0, points.length - 1)} value={selectedIndex ?? 0} onChange={(event) => setSelectedIndex(Number(event.target.value))} aria-valuetext={formatDateTime(points[selectedIndex ?? 0]?.time)} />
          <div className="stream-chart-values" aria-live="polite">
            {selected == null ? <span className="muted">Hover over the chart or use the slider to see values.</span> : <><strong>{formatDateTime(selected.time)}</strong><span>{formatCount(selected.viewers)} average / {formatCount(selected.viewerPeak)} peak viewers</span><span>{formatCount(selected.messagesPerMinute)} messages / min</span><span>{formatCount(selected.activeChatters)} peak active chatters</span>{selected.interrupted ? <span className="muted">Missing observations in or before this interval</span> : null}</>}
          </div>
        </div>
        <figcaption className="data-note padded">Viewers use the left scale; chat activity uses the right. Dashed green shows peak viewers. Active chatters are the maximum distinct speakers in an original activity interval, not unique people across the session. Missing observations appear as gaps.</figcaption>
      </figure>}
    </section>
    {highlights.length === 0 ? null : <section className="stream-highlights" aria-label="Session highlights">{highlights.map((highlight) => <button className="stream-highlight" type="button" key={highlight.label} onClick={() => focusTime(highlight.time)} disabled={!hasData}>
      <span className="stat-label">{highlight.label}</span><strong>{highlight.value}</strong><span className="stat-detail">{formatDateTime(highlight.time)}</span>
    </button>)}</section>}
  </>;
}

function axisTime(value: string | undefined) {
  return value == null ? "—" : new Date(value).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
}
