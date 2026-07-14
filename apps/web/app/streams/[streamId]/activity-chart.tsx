"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

type ActivityPoint = {
  time: string;
  viewers: number | null;
  messages: number;
  activeChatters: number | null;
};

export function StreamActivityChart({ points }: { points: ActivityPoint[] }) {
  if (points.length === 0) {
    return <p className="muted padded">No chartable activity data yet.</p>;
  }

  return (
    <figure className="chart-figure">
      <div className="chart-wrap">
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={points} margin={{ top: 8, right: 18, bottom: 8, left: 0 }} accessibilityLayer>
            <CartesianGrid stroke="rgba(255,255,255,0.08)" strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey="time" minTickGap={32} tick={{ fill: "#8f899b", fontSize: 11 }} axisLine={{ stroke: "rgba(255,255,255,0.1)" }} tickLine={false} />
            <YAxis yAxisId="left" tick={{ fill: "#8f899b", fontSize: 11 }} axisLine={false} tickLine={false} width={42} />
            <YAxis yAxisId="right" orientation="right" tick={{ fill: "#8f899b", fontSize: 11 }} axisLine={false} tickLine={false} width={42} />
            <Tooltip contentStyle={{ background: "#211d2f", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, boxShadow: "0 14px 36px rgba(0,0,0,0.35)", fontSize: 12 }} labelStyle={{ color: "#f7f5fb", fontWeight: 700 }} />
            <Legend iconType="circle" iconSize={7} wrapperStyle={{ color: "#a7a1b4", fontSize: 11, paddingTop: 10 }} />
            <Line yAxisId="left" type="monotone" dataKey="viewers" name="Viewers" stroke="#48d597" dot={false} strokeWidth={2.25} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
            <Line yAxisId="right" type="monotone" dataKey="messages" name="Messages" stroke="#a970ff" dot={false} strokeWidth={2.25} activeDot={{ r: 4 }} isAnimationActive={false} />
            <Line yAxisId="right" type="monotone" dataKey="activeChatters" name="Active chatters" stroke="#f4c86b" dot={false} strokeWidth={2.25} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">Viewer snapshots, captured messages, and active chatter estimates over the stream session. Missing observations are shown as gaps.</figcaption>
    </figure>
  );
}
