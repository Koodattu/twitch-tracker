"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ChannelDay, ChannelOverview } from "@twitch-tracker/shared";
import { formatCount, formatDateTime, formatDuration } from "../../format";
import { EmptyState } from "../../ui";
import { channelSearchParams, channelViewQuery, readChannelView, type ChannelView } from "./channel-view";

const height = 240;
const plot = { left: 58, right: 20, top: 18, bottom: 42 };

export function ViewerTrendChart({ overview, login }: { overview: ChannelOverview; login: string }) {
  const search = useSearchParams();
  const view = readChannelView(channelSearchParams(search), overview.asOf.slice(0, 10));
  const mode = view.measure;
  const [width, setWidth] = useState(1000);
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const [share, setShare] = useState<{ url: string; copied: boolean } | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const pathname = `/channels/${encodeURIComponent(login)}`;
  const dayCount = Math.round((Date.parse(overview.toDay) - Date.parse(overview.fromDay)) / 86_400_000) + 1;
  const days = Array.from({ length: dayCount }, (_, index) => {
    const day = new Date(Date.parse(overview.fromDay) + index * 86_400_000).toISOString().slice(0, 10);
    return { day, activity: overview.daily.find((record) => record.day === day) };
  });
  const latest = overview.daily.findLast((day) => mode === "viewers" ? day.viewerCountMax != null : day.messageCount > 0);
  const selectedDay = days.find((point) => point.day === view.day)?.day ?? latest?.day ?? overview.toDay;
  const selectedIndex = Math.max(0, days.findIndex((point) => point.day === (hoverDay ?? selectedDay)));
  const selected = days[selectedIndex]!;
  const getValue = (day: ChannelDay | undefined) => mode === "viewers" ? day?.viewerCountAvg : day?.messageCount;
  const maximum = Math.max(1, ...days.map(({ activity }) => mode === "viewers" ? activity?.viewerCountMax ?? 0 : activity?.messageCount ?? 0));
  const x = (index: number) => plot.left + index / (dayCount - 1) * (width - plot.left - plot.right);
  const y = (value: number) => plot.top + (1 - value / maximum) * (height - plot.top - plot.bottom);
  const hasValues = days.some(({ activity }) => mode === "viewers" ? activity?.viewerCountMax != null : (activity?.messageCount ?? 0) > 0);
  useEffect(() => {
    const element = chartRef.current;
    if (element == null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry != null) setWidth(Math.max(240, entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasValues]);
  function update(next: ChannelView, replace = false) {
    setHoverDay(null);
    setShare(null);
    const href = `${pathname}?${channelViewQuery(next)}`;
    if (replace) window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
  }
  function selectDay(day: string, replace = false) {
    update({ ...view, end: overview.toDay, day }, replace);
  }
  function streamHref(day: string) {
    return `${pathname}/streams?${channelViewQuery({ ...view, end: overview.toDay, day })}`;
  }
  async function copyLink() {
    const url = `${window.location.origin}${pathname}?${channelViewQuery({ ...view, end: overview.toDay, day: selectedDay })}`;
    try { await navigator.clipboard.writeText(url); setShare({ url, copied: true }); }
    catch { setShare({ url, copied: false }); }
  }
  function path(peak: boolean) {
    let drawing = false;
    return days.map(({ activity }, index) => {
      const value = peak ? activity?.viewerCountMax : getValue(activity);
      if (value == null) { drawing = false; return ""; }
      const segment = `${drawing ? "L" : "M"} ${x(index).toFixed(2)} ${y(value).toFixed(2)}`;
      drawing = true;
      return segment;
    }).join(" ");
  }
  const peakDay = overview.daily.filter((day) => day.viewerCountMax != null).sort((a, b) => b.viewerCountMax! - a.viewerCountMax!)[0];
  function focusDay(day: string, nextMode: "viewers" | "messages") {
    update({ ...view, end: overview.toDay, day, measure: nextMode });
    chartRef.current?.focus();
  }
  function dayAtPointer(event: React.MouseEvent<SVGSVGElement> | React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const position = (event.clientX - rect.left) / rect.width * width;
    return days[Math.max(0, Math.min(dayCount - 1, Math.round((position - plot.left) / (width - plot.left - plot.right) * (dayCount - 1))))]!.day;
  }
  return <section className="panel channel-audience">
      <div className="panel-header"><div className="panel-heading"><h2>{mode === "viewers" ? "Audience over time" : "Chat over time"}</h2><p>{mode === "viewers" ? "Daily average and peak viewers" : "Daily captured messages"} · {dayCount} days</p></div>
        <div className="channel-chart-tabs" role="group" aria-label="Chart measure">
          <button type="button" aria-pressed={mode === "viewers"} onClick={() => update({ ...view, measure: "viewers" })}>Viewers</button>
          <button type="button" aria-pressed={mode === "messages"} onClick={() => update({ ...view, measure: "messages" })}>Messages</button>
        </div>
      </div>
      {!hasValues ? <EmptyState title={mode === "viewers" ? "No viewer observations in this period" : "No chat activity recorded in this period"} description="Try another period or explore the daily figures and stream history." /> : <figure className="chart-figure">
        <div className="channel-chart-legend" aria-hidden="true">{mode === "viewers" ? <><span><i />Average viewers</span><span><i className="channel-peak-key" />Peak viewers</span></> : <span><i className="channel-message-key" />Messages captured</span>}</div>
        <div className="chart-wrap" ref={chartRef} tabIndex={-1}>
          <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Daily ${mode} from ${overview.fromDay} to ${overview.toDay}. Use the day slider or daily figures to inspect values.`}
            onPointerMove={(event) => { if (event.pointerType === "mouse") setHoverDay(dayAtPointer(event)); }} onPointerLeave={() => setHoverDay(null)} onClick={(event) => selectDay(dayAtPointer(event))}>
            <g className="chart-grid" aria-hidden="true">{[0, 0.5, 1].map((ratio) => <line key={ratio} x1={plot.left} x2={width - plot.right} y1={y(ratio * maximum)} y2={y(ratio * maximum)} />)}</g>
            <g className="chart-axis-labels" aria-hidden="true"><text x={plot.left - 10} y={plot.top + 4} textAnchor="end">{formatCount(maximum)}</text><text x={plot.left - 10} y={y(maximum / 2) + 4} textAnchor="end">{formatCount(Math.round(maximum / 2))}</text><text x={plot.left - 10} y={height - plot.bottom + 4} textAnchor="end">0</text><text x={plot.left} y={height - 14}>{overview.fromDay}</text><text x={width - plot.right} y={height - 14} textAnchor="end">{overview.toDay}</text></g>
            <path className={`chart-line chart-line-${mode === "viewers" ? "viewers" : "messages"}`} d={path(false)} vectorEffect="non-scaling-stroke" />
            {mode === "viewers" ? <path className="chart-line chart-line-viewers stream-chart-peak" d={path(true)} vectorEffect="non-scaling-stroke" /> : null}
            {mode === "viewers" ? days.map(({ day, activity }, index) => activity?.viewerCountMax == null ? null : <circle key={`peak-${day}`} className="stream-chart-point chart-line-viewers stream-chart-peak" cx={x(index)} cy={y(activity.viewerCountMax)} r={2} />) : null}
            {days.map(({ day, activity }, index) => {
              const value = getValue(activity);
              return value == null ? null : <circle key={day} className={`stream-chart-point chart-line-${mode === "viewers" ? "viewers" : "messages"}`} cx={x(index)} cy={y(value)} r={3} />;
            })}
            <line className="stream-chart-cursor" x1={x(selectedIndex)} x2={x(selectedIndex)} y1={plot.top} y2={height - plot.bottom} />
          </svg>
        </div>
        <div className="channel-chart-inspector">
          <div className="channel-chart-values"><strong>{selected.day}</strong>{selected.activity == null ? <span>No observations</span> : <>
            {mode === "viewers" ? <><span><b>{formatCount(selected.activity.viewerCountAvg)}</b> avg viewers</span><span><b>{formatCount(selected.activity.viewerCountMax)}</b> peak viewers</span></> : <span><b>{formatCount(selected.activity.messageCount)}</b> messages captured</span>}
            <span><b>{formatDuration(selected.activity.liveSeconds)}</b> streamed</span>
          </>}</div>
          <label className="sr-only" htmlFor="channel-chart-day">Inspect a day (UTC)</label>
          <input id="channel-chart-day" type="range" min={0} max={dayCount - 1} value={selectedIndex} onChange={(event) => selectDay(days[Number(event.target.value)]!.day, true)} aria-valuetext={`${selected.day}: ${formatCount(getValue(selected.activity), "no observed")} ${mode === "viewers" ? "average viewers" : "messages"}`} />
          <div className="channel-chart-actions"><Link href={streamHref(selected.day)} prefetch={false}>Streams on {selected.day}</Link><button type="button" onClick={copyLink}>Copy view link</button></div>
          {share == null ? null : <div className="channel-share-result" role="status">{share.copied ? "View link copied. It includes the period, measure and selected day." : <label>Copy this view link<input readOnly value={share.url} onFocus={(event) => event.currentTarget.select()} /></label>}</div>}
        </div>
        <figcaption className="channel-chart-footer"><span className="channel-caption">Click or tap a day to keep it selected. Use the slider for keyboard inspection. Missing days remain gaps.</span>
          {peakDay == null ? null : <button type="button" onClick={() => focusDay(peakDay.day, "viewers")}>Peak audience: {formatCount(peakDay.viewerCountMax)} · {peakDay.day} ↗</button>}
        </figcaption>
      </figure>}
      <p className="channel-chart-updated channel-caption">Loaded {formatDateTime(overview.asOf)}. Reload to refresh; captured chat can take a few minutes to update.</p>
      <details className="channel-daily"><summary>Daily figures · {dayCount} days</summary>
        <p className="channel-caption">The same UTC days and values as the chart. A dash means no observation; zero messages means none captured, not necessarily no chat. Open a day to see its streams.</p>
        <div className="table-scroll" role="region" aria-label="Daily chart figures" tabIndex={0}><table className="table table-compact">
          <caption className="sr-only">Channel figures from {overview.fromDay} to {overview.toDay}, UTC</caption>
          <thead><tr><th scope="col">Day (UTC)</th><th scope="col">Avg viewers</th><th scope="col">Peak viewers</th><th scope="col">Stream time</th><th scope="col">Streams started</th><th scope="col">Messages captured</th></tr></thead>
          <tbody>{[...days].reverse().map(({ day, activity }) => <tr key={day} aria-current={day === selectedDay ? "date" : undefined}><th scope="row"><Link href={streamHref(day)} prefetch={false}>{day}</Link></th><td className="number-cell">{formatCount(activity?.viewerCountAvg)}</td><td className="number-cell">{formatCount(activity?.viewerCountMax)}</td><td className="number-cell">{activity == null ? "—" : formatDuration(activity.liveSeconds)}</td><td className="number-cell">{formatCount(activity?.streamCount)}</td><td className="number-cell">{formatCount(activity?.messageCount)}</td></tr>)}</tbody>
        </table></div>
      </details>
    </section>;
}
