"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

export type ViewerTrendPoint = {
  time: string;
  viewers: number | null;
  title: string;
};

export function ViewerTrendChart({ points }: { points: ViewerTrendPoint[] }) {
  if (points.length === 0) {
    return <p className="muted padded">No chartable viewer snapshots yet.</p>;
  }

  return (
    <figure className="chart-figure">
      <div className="chart-wrap">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={points} margin={{ top: 8, right: 18, bottom: 8, left: 0 }} accessibilityLayer>
            <CartesianGrid stroke="rgba(255,255,255,0.08)" strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey="time" minTickGap={34} tick={{ fill: "#8f899b", fontSize: 11 }} axisLine={{ stroke: "rgba(255,255,255,0.1)" }} tickLine={false} />
            <YAxis tick={{ fill: "#8f899b", fontSize: 11 }} axisLine={false} tickLine={false} width={46} />
            <Tooltip
              contentStyle={{ background: "#211d2f", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, boxShadow: "0 14px 36px rgba(0,0,0,0.35)", fontSize: 12 }}
              labelStyle={{ color: "#f7f5fb", fontWeight: 700 }}
              formatter={(value) => [value == null ? "No snapshot" : Number(value).toLocaleString("en-GB"), "Viewers"]}
            />
            <Line type="monotone" dataKey="viewers" name="Viewers" stroke="#48d597" dot={false} strokeWidth={2.25} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">Viewer snapshots over time. Gaps separate distinct stream sessions.</figcaption>
    </figure>
  );
}
