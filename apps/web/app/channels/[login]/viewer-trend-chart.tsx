"use client";

import { useEffect, useRef, useState } from "react";
import type { ChannelDay, ChannelOverview } from "@twitch-tracker/shared";
import { formatCount, formatDuration } from "../../format";
import { EmptyState } from "../../ui";

const height = 240;
const plot = { left: 58, right: 20, top: 18, bottom: 42 };

export function ViewerTrendChart({ overview }: { overview: ChannelOverview }) {
  const [width, setWidth] = useState(1000);
  const [mode, setMode] = useState<"viewers" | "messages">("viewers");
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const latest = overview.daily.findLast((day) => day.viewerCountMax != null);
    return latest == null ? 29 : Math.max(0, Math.min(29, Math.round((Date.parse(latest.day) - Date.parse(overview.fromDay)) / 86_400_000)));
  });
  const chartRef = useRef<HTMLDivElement>(null);
  const days = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(Date.parse(overview.fromDay) + index * 86_400_000).toISOString().slice(0, 10);
    return { day, activity: overview.daily.find((record) => record.day === day) };
  });
  const selected = days[selectedIndex]!;
  const getValue = (day: ChannelDay | undefined) => mode === "viewers" ? day?.viewerCountAvg : day?.messageCount;
  const maximum = Math.max(1, ...days.map(({ activity }) => mode === "viewers" ? activity?.viewerCountMax ?? 0 : activity?.messageCount ?? 0));
  const x = (index: number) => plot.left + index / 29 * (width - plot.left - plot.right);
  const y = (value: number) => plot.top + (1 - value / maximum) * (height - plot.top - plot.bottom);
  const hasValues = days.some(({ activity }) => mode === "viewers" ? activity?.viewerCountMax != null : (activity?.messageCount ?? 0) > 0);
  useEffect(() => {
    const element = chartRef.current;
    if (element == null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry != null) setWidth(Math.max(280, entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasValues]);
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
    setMode(nextMode);
    setSelectedIndex(days.findIndex((point) => point.day === day));
    chartRef.current?.focus();
  }
  return <section className="panel channel-audience">
      <div className="panel-header"><div className="panel-heading"><h2>{mode === "viewers" ? "Audience over time" : "Chat over time"}</h2><p>{mode === "viewers" ? "Daily average and peak viewers · Last 30 days" : "Daily captured messages · Last 30 days"}</p></div>
        <div className="channel-chart-tabs" role="group" aria-label="Chart measure">
          <button type="button" aria-pressed={mode === "viewers"} onClick={() => setMode("viewers")}>Viewers</button>
          <button type="button" aria-pressed={mode === "messages"} onClick={() => setMode("messages")}>Messages</button>
        </div>
      </div>
      {!hasValues ? <EmptyState title={mode === "viewers" ? "No viewer observations in this period" : "No chat activity recorded in this period"} description="More activity will appear as streams are observed. Explore the channel’s stream history below." /> : <figure className="chart-figure">
        <div className="channel-chart-legend" aria-hidden="true">{mode === "viewers" ? <><span><i />Average viewers</span><span><i className="channel-peak-key" />Peak viewers</span></> : <span><i className="channel-message-key" />Messages captured</span>}</div>
        <div className="chart-wrap" ref={chartRef} tabIndex={-1}>
          <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Daily ${mode} from ${overview.fromDay} to ${overview.toDay}. Use the day slider to inspect values.`} onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const position = (event.clientX - rect.left) / rect.width * width;
            setSelectedIndex(Math.max(0, Math.min(29, Math.round((position - plot.left) / (width - plot.left - plot.right) * 29))));
          }}>
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
          <input id="channel-chart-day" type="range" min={0} max={29} value={selectedIndex} onChange={(event) => setSelectedIndex(Number(event.target.value))} aria-valuetext={`${selected.day}: ${formatCount(getValue(selected.activity), "no observed")} ${mode === "viewers" ? "average viewers" : "messages"}`} />
        </div>
        <figcaption className="channel-chart-footer"><span className="channel-caption">Move across the chart or use the slider to explore. Missing days remain gaps.</span>
          {peakDay == null ? null : <button type="button" onClick={() => focusDay(peakDay.day, "viewers")}>Peak audience: {formatCount(peakDay.viewerCountMax)} · {peakDay.day} ↗</button>}
        </figcaption>
      </figure>}
    </section>;
}
