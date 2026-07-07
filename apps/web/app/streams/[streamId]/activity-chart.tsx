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
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={points} margin={{ top: 8, right: 18, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="#d8e4e0" strokeDasharray="3 3" />
          <XAxis dataKey="time" minTickGap={32} tick={{ fontSize: 12 }} />
          <YAxis yAxisId="left" tick={{ fontSize: 12 }} />
          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} />
          <Tooltip />
          <Line yAxisId="left" type="monotone" dataKey="viewers" name="Viewers" stroke="#256f68" dot={false} strokeWidth={2} connectNulls />
          <Line yAxisId="right" type="monotone" dataKey="messages" name="Messages" stroke="#6f4e25" dot={false} strokeWidth={2} />
          <Line yAxisId="right" type="monotone" dataKey="activeChatters" name="Active chatters" stroke="#7c3aed" dot={false} strokeWidth={2} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
