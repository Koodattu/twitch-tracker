"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { StreamChartPoint, StreamOverview } from "@twitch-tracker/shared";
import { formatCount, formatDateTime } from "../../format";
import { EmptyState } from "../../ui";
import { readStreamView, streamIntervalQuery, streamViewQuery, type StreamView } from "./stream-view";

const plot = { left: 50, right: 50, top: 28, bottom: 222, height: 254 };
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
  const [keyboardInspecting, setKeyboardInspecting] = useState(false);
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
  const visibleSeries = series.filter((item) => view.series.includes(item.key));
  // Keep both scales stable when a metric is hidden so toggling cannot change a trend's apparent size.
  const viewerMaximum = Math.max(1, ...points.map((point) => Math.max(point.viewers ?? 0, point.viewerPeak ?? 0)));
  const chatMaximum = Math.max(1, ...points.map((point) => Math.max(point.messagesPerMinute ?? 0, point.activeChatters ?? 0)));
  const inspecting = hoverIndex != null || keyboardInspecting || (view.at != null && validTime);
  const y = (value: number, key: typeof series[number]["key"] | "viewerPeak") =>
    plot.top + (1 - value / (key === "viewers" || key === "viewerPeak" ? viewerMaximum : chatMaximum)) * (plot.bottom - plot.top);
  const x = (point: StreamChartPoint) => points.length === 1 ? (plot.left + width - plot.right) / 2
    : plot.left + (Date.parse(point.time) - firstTime) / Math.max(1, lastTime - firstTime) * (width - plot.left - plot.right);
  const hasData = points.some((point) => point.viewers != null || point.viewerPeak != null || point.messagesPerMinute != null || point.activeChatters != null);
  const invalid = view.invalid || (view.at != null && !validTime);
  const tooltipWidth = Math.min(242, width - 16);
  const tooltipLeft = selected == null ? 8 : Math.max(8, Math.min(width - tooltipWidth - 8,
    x(selected) > width / 2 ? x(selected) - tooltipWidth - 14 : x(selected) + 14));
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
    const query = streamViewQuery({ ...next, returnTo: view.returnTo });
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
    chartRef.current?.scrollIntoView({ block: "center" });
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
  function path(key: typeof series[number]["key"] | "viewerPeak") {
    let drawing = false;
    return points.map((point) => {
      const value = point[key];
      if (value == null) { drawing = false; return ""; }
      if (point.interrupted) drawing = false;
      const segment = `${drawing ? "L" : "M"} ${x(point).toFixed(2)} ${y(value, key).toFixed(2)}`;
      drawing = true;
      return segment;
    }).join(" ");
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
        <div className="chart-legend stream-chart-controls" role="group" aria-label="Visible metrics">{series.map((item) => <button type="button" aria-pressed={view.series.includes(item.key)} key={item.key} onClick={() => update({ ...view, series: series.filter((candidate) => candidate.key === item.key ? !view.series.includes(item.key) : view.series.includes(candidate.key)).map((candidate) => candidate.key) })}><i className={`chart-key-${item.color}`} aria-hidden="true" />{item.label}</button>)}</div>
        <div className="stream-activity-plot" ref={chartRef} tabIndex={visibleSeries.length === 0 ? -1 : 0} role="group" aria-label="Inspect stream activity" aria-describedby="stream-chart-help" onFocus={() => setKeyboardInspecting(true)} onBlur={() => setKeyboardInspecting(false)} onKeyDown={(event) => {
          const next = event.key === "Home" ? 0 : event.key === "End" ? points.length - 1
            : event.key === "ArrowLeft" ? Math.max(0, committedIndex - 1) : event.key === "ArrowRight" ? Math.min(points.length - 1, committedIndex + 1) : null;
          if (next != null) { event.preventDefault(); select(next, true); }
        }}>
          {visibleSeries.length === 0 ? <EmptyState title="Choose a metric" description="Select a legend label to show viewers or chat activity. Interval figures remain available below." /> : <>
            <svg className="line-chart stream-activity-chart" viewBox={`0 0 ${width} ${plot.height}`} role="img" aria-label="Stream activity: viewers on the left scale; messages per minute and active chatters on the right scale."
              onPointerMove={(event) => { if (event.pointerType === "mouse") setHoverIndex(pointerIndex(event)); }} onPointerLeave={() => setHoverIndex(null)} onClick={(event) => { select(pointerIndex(event)); chartRef.current?.focus({ preventScroll: true }); }}>
              <g className="chart-grid" aria-hidden="true">{[0, 0.5, 1].map((ratio) => <line key={ratio} x1={plot.left} x2={width - plot.right} y1={y(ratio * viewerMaximum, "viewers")} y2={y(ratio * viewerMaximum, "viewers")} />)}</g>
              <g className="chart-axis-labels" aria-hidden="true">
                <text x={0} y={14}>Viewers</text><text x={width} y={14} textAnchor="end">Chat activity</text>
                {[0, 0.5, 1].map((ratio) => <g key={ratio}><text x={plot.left - 8} y={y(ratio * viewerMaximum, "viewers") + 4} textAnchor="end">{axisCount(ratio * viewerMaximum)}</text><text x={width - plot.right + 8} y={y(ratio * chatMaximum, "activeChatters") + 4}>{axisCount(ratio * chatMaximum)}</text></g>)}
                <text x={0} y={plot.height - 8}>{axisTime(points[0]?.time)}</text><text x={width} y={plot.height - 8} textAnchor="end">{axisTime(points.at(-1)?.time)}</text>
              </g>
              {visibleSeries.flatMap((item) => (item.key === "viewers" ? ["viewers", "viewerPeak"] as const : [item.key]).map((key) => <g key={key}>
                <path className={`chart-line chart-line-${item.color}${key === "viewerPeak" ? " stream-chart-peak" : ""}`} d={path(key)} vectorEffect="non-scaling-stroke" />
                {points.map((point, index) => {
                  const value = point[key];
                  if (value == null) return null;
                  const highlighted = index === intervalIndex && inspecting;
                  const startsSegment = index === 0 || points[index - 1]![key] == null || point.interrupted;
                  const endsSegment = index === points.length - 1 || points[index + 1]![key] == null || points[index + 1]!.interrupted;
                  return highlighted || startsSegment && endsSegment
                    ? <circle key={point.time} className={`stream-chart-point chart-line-${item.color}`} cx={x(point)} cy={y(value, key)} r={highlighted ? 3.5 : 2.5} /> : null;
                })}
              </g>))}
              {!inspecting || selected == null ? null : <line className="stream-chart-cursor" x1={x(selected)} x2={x(selected)} y1={plot.top} y2={plot.bottom} />}
            </svg>
            {!inspecting || selected == null ? null : <div className="stream-chart-tooltip" style={{ left: tooltipLeft, width: tooltipWidth }} aria-hidden="true">
              <strong>{formatDateTime(selected.time)}</strong>
              <dl>{series.filter((item) => view.series.includes(item.key)).map((item) => <div key={item.key}><dt><i className={`chart-key-${item.color}`} />{item.label}</dt><dd>{item.key === "viewers" ? `${formatCount(selected.viewers)} / ${formatCount(selected.viewerPeak)}` : formatCount(selected[item.key])}</dd></div>)}</dl>
              {selected.interrupted ? <span className="muted">Missing or partial activity records</span> : null}
            </div>}
          </>}
        </div>
        <div className="stream-chart-inspector">
          <p id="stream-chart-help" className="muted">Hover to inspect. Click or tap to pin. Arrow keys move the selection.</p>
          <div className="stream-chart-values sr-only" aria-live={hoverIndex == null ? "polite" : "off"}>
            {selected == null ? null : <><strong>{formatDateTime(selected.time)}. </strong><span>{formatCount(selected.viewers)} average / {formatCount(selected.viewerPeak)} peak viewers. </span><span>{formatCount(selected.messagesPerMinute)} messages / min. </span><span>{formatCount(selected.activeChatters)} peak active chatters. </span>{selected.interrupted ? <span className="muted">Missing observations in or before this interval</span> : null}</>}
          </div>
          <div className="stream-inspection-actions">
            {committed == null || !validTime ? null : <Link href={eventsHref(committed)} prefetch={false}>Events in this interval</Link>}
            <button type="button" onClick={copyLink}>Copy view link</button>
            {!invalid && view.at == null && visibleSeries.length === series.length ? null : <button type="button" onClick={() => update({ series: series.map((item) => item.key) })}>Reset view</button>}
          </div>
          {share == null ? null : <div className="stream-share-result" role="status">{share.copied ? "View link copied. It includes the selected interval and visible metrics." : <label>Copy this view link<input className="search-input" readOnly value={share.url} onFocus={(event) => event.currentTarget.select()} /></label>}</div>}
        </div>
        <figcaption className="data-note padded">Viewers: left scale. Chat: right scale. Dashed: peak viewers. Zero means no captured chat; gaps mean missing activity records. Capture may be incomplete.</figcaption>
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

function axisCount(value: number) {
  return new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
