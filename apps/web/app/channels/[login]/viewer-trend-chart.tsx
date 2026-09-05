"use client";

import { useRef, useState } from "react";
import type { ChannelDay, ChannelOverview } from "@twitch-tracker/shared";
import { formatCount, formatDuration } from "../../format";
import { EmptyState } from "../../ui";

const width = 800;
const height = 280;
const plot = { left: 58, right: 20, top: 18, bottom: 42 };

export function ViewerTrendChart({ overview }: { overview: ChannelOverview }) {
  const [mode, setMode] = useState<"viewers" | "messages">("viewers");
  const [selectedIndex, setSelectedIndex] = useState(29);
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
  const hasValues = days.some(({ activity }) => getValue(activity) != null);
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
  const busiestDay = overview.daily.filter((day) => day.messageCount > 0).sort((a, b) => b.messageCount - a.messageCount)[0];
  function focusDay(day: string, nextMode: "viewers" | "messages") {
    setMode(nextMode);
    setSelectedIndex(days.findIndex((point) => point.day === day));
    chartRef.current?.focus();
  }
  return <>
    <section className="panel">
      <div className="panel-header"><div className="panel-heading"><h2>Daily activity</h2><p>Compare observed days over the same 30-day period</p></div></div>
      <div className="chart-legend stream-chart-controls">
        <button className="button button-secondary button-compact" type="button" aria-pressed={mode === "viewers"} onClick={() => setMode("viewers")}><i className="chart-key-viewers" />Viewers</button>
        <button className="button button-secondary button-compact" type="button" aria-pressed={mode === "messages"} onClick={() => setMode("messages")}><i className="chart-key-messages" />Messages</button>
      </div>
      {!hasValues ? <EmptyState title={mode === "viewers" ? "No viewer observations in this period" : "No daily activity in this period"} description="Choose another measure or explore the channel’s stream history." /> : <figure className="chart-figure">
        <div className="chart-wrap" ref={chartRef} tabIndex={-1}>
          <svg className="line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Daily ${mode} from ${overview.fromDay} to ${overview.toDay}. Use the day slider to inspect values.`} onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const position = (event.clientX - rect.left) / rect.width * width;
            setSelectedIndex(Math.max(0, Math.min(29, Math.round((position - plot.left) / (width - plot.left - plot.right) * 29))));
          }}>
            <g className="chart-grid" aria-hidden="true">{[0, 0.5, 1].map((ratio) => <line key={ratio} x1={plot.left} x2={width - plot.right} y1={y(ratio * maximum)} y2={y(ratio * maximum)} />)}</g>
            <g className="chart-axis-labels" aria-hidden="true"><text x={plot.left - 10} y={plot.top + 4} textAnchor="end">{formatCount(maximum)}</text><text x={plot.left - 10} y={height - plot.bottom + 4} textAnchor="end">0</text><text x={plot.left} y={height - 14}>{overview.fromDay}</text><text x={width - plot.right} y={height - 14} textAnchor="end">{overview.toDay}</text></g>
            <path className={`chart-line chart-line-${mode === "viewers" ? "viewers" : "messages"}`} d={path(false)} vectorEffect="non-scaling-stroke" />
            {mode === "viewers" ? <path className="chart-line chart-line-viewers stream-chart-peak" d={path(true)} vectorEffect="non-scaling-stroke" /> : null}
            {days.map(({ day, activity }, index) => {
              const value = getValue(activity);
              return value == null ? null : <circle key={day} className={`stream-chart-point chart-line-${mode === "viewers" ? "viewers" : "messages"}`} cx={x(index)} cy={y(value)} r={3} />;
            })}
            <line className="stream-chart-cursor" x1={x(selectedIndex)} x2={x(selectedIndex)} y1={plot.top} y2={height - plot.bottom} />
          </svg>
        </div>
        <div className="stream-chart-inspector"><label htmlFor="channel-chart-day">Inspect a day (UTC)</label>
          <input id="channel-chart-day" type="range" min={0} max={29} value={selectedIndex} onChange={(event) => setSelectedIndex(Number(event.target.value))} aria-valuetext={selected.day} />
          <div className="stream-chart-values" aria-live="polite"><strong>{selected.day}</strong>{selected.activity == null ? <span className="muted">No daily observations</span> : <>
            <span>{formatCount(selected.activity.viewerCountAvg)} average / {formatCount(selected.activity.viewerCountMax)} peak viewers</span>
            <span>{formatCount(selected.activity.messageCount)} messages</span><span>{formatCount(selected.activity.streamCount)} {selected.activity.streamCount === 1 ? "stream" : "streams"} started</span><span>{formatDuration(selected.activity.liveSeconds)} stream time</span>
          </>}</div>
        </div>
        <figcaption className="data-note padded">{mode === "viewers" ? "Solid green shows daily average viewers; dashed green shows daily peaks. " : "Messages are daily captured totals. "}Missing days remain gaps.</figcaption>
      </figure>}
    </section>
    {peakDay == null && busiestDay == null ? null : <section className="stream-highlights" aria-label="Channel highlights">
      {peakDay == null ? null : <button className="stream-highlight" type="button" onClick={() => focusDay(peakDay.day, "viewers")}><span className="stat-label">Peak audience day</span><strong>{formatCount(peakDay.viewerCountMax)} viewers</strong><span className="stat-detail">{peakDay.day} · Inspect day</span></button>}
      {busiestDay == null ? null : <button className="stream-highlight" type="button" onClick={() => focusDay(busiestDay.day, "messages")}><span className="stat-label">Busiest chat day</span><strong>{formatCount(busiestDay.messageCount)} messages</strong><span className="stat-detail">{busiestDay.day} · Inspect day</span></button>}
    </section>}
  </>;
}
