import type { ChannelCategory, ChannelDay } from "@twitch-tracker/shared";

type PeriodSession = { twitchStreamId: string; startedAt: Date; endedAt: Date | null; lastSeenLiveAt: Date };
type PeriodSample = { twitchStreamId: string; observedAt: Date; viewerCount: number | null; categoryId: string | null; categoryName: string | null };

export function summarizeChannelPeriod(input: {
  from: Date; to: Date; maxGapSeconds: number;
  sessions: PeriodSession[]; samples: PeriodSample[];
  messages: { day: string; messageCount: number }[];
}) {
  const from = input.from.getTime(), to = input.to.getTime();
  const days = new Map<string, ChannelDay & { viewerSeconds: number; viewerIntegral: number }>();
  const categories = new Map<string, ChannelCategory & { viewerSeconds: number; viewerIntegral: number }>();
  const dayAt = (time: number) => {
    const day = new Date(time).toISOString().slice(0, 10);
    let record = days.get(day);
    if (record == null) {
      record = { day, streamCount: 0, liveSeconds: 0, viewerCountMax: null, viewerCountAvg: null, messageCount: 0, viewerSeconds: 0, viewerIntegral: 0 };
      days.set(day, record);
    }
    return record;
  };
  const splitDays = (start: number, end: number, visit: (day: ReturnType<typeof dayAt>, seconds: number) => void) => {
    for (let cursor = Math.max(from, start); cursor < Math.min(to, end);) {
      const next = Math.min(to, end, (Math.floor(cursor / 86_400_000) + 1) * 86_400_000);
      visit(dayAt(cursor), (next - cursor) / 1000);
      cursor = next;
    }
  };
  const sessionEnds = new Map<string, number>();
  for (const session of input.sessions) {
    const start = session.startedAt.getTime();
    const end = Math.min(to, (session.endedAt ?? session.lastSeenLiveAt).getTime());
    sessionEnds.set(session.twitchStreamId, end);
    if (start >= from && start < to) dayAt(start).streamCount++;
    splitDays(start, end, (day, seconds) => { day.liveSeconds += seconds; });
  }
  for (const message of input.messages) {
    const time = Date.parse(message.day);
    if (time >= from && time < to) dayAt(time).messageCount = message.messageCount;
  }
  const samples = [...input.samples].sort((a, b) => a.twitchStreamId.localeCompare(b.twitchStreamId) || a.observedAt.getTime() - b.observedAt.getTime());
  for (const [index, sample] of samples.entries()) {
    const start = sample.observedAt.getTime();
    const sessionEnd = sessionEnds.get(sample.twitchStreamId);
    if (sessionEnd == null) continue;
    if (start >= from && start < to && sample.viewerCount != null) {
      const day = dayAt(start);
      day.viewerCountMax = Math.max(day.viewerCountMax ?? 0, sample.viewerCount);
    }
    const next = samples[index + 1];
    const end = Math.min(sessionEnd, start + input.maxGapSeconds * 1000,
      next?.twitchStreamId === sample.twitchStreamId ? next.observedAt.getTime() : sessionEnd);
    const seconds = Math.max(0, end - Math.max(start, from)) / 1000;
    if (seconds === 0) continue;
    if (sample.viewerCount != null) {
      splitDays(start, end, (day, duration) => {
        day.viewerSeconds += duration;
        day.viewerIntegral += sample.viewerCount! * duration;
        day.viewerCountMax = Math.max(day.viewerCountMax ?? 0, sample.viewerCount!);
      });
    }
    if (sample.categoryId != null && sample.categoryId !== "") {
      let category = categories.get(sample.categoryId);
      if (category == null) {
        category = { id: sample.categoryId, name: sample.categoryName || "Unknown category", liveSeconds: 0, viewerCountAvg: null, viewerSeconds: 0, viewerIntegral: 0 };
        categories.set(sample.categoryId, category);
      }
      if (sample.categoryName) category.name = sample.categoryName;
      category.liveSeconds += seconds;
      if (sample.viewerCount != null) {
        category.viewerSeconds += seconds;
        category.viewerIntegral += seconds * sample.viewerCount;
      }
    }
  }
  const records = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  const viewerSeconds = records.reduce((sum, day) => sum + day.viewerSeconds, 0);
  const viewerIntegral = records.reduce((sum, day) => sum + day.viewerIntegral, 0);
  const peaks = records.flatMap((day) => day.viewerCountMax == null ? [] : [day.viewerCountMax]);
  const allCategories = [...categories.values()].map(({ viewerSeconds: seconds, viewerIntegral: integral, ...category }) => ({
    ...category, viewerCountAvg: seconds === 0 ? null : Math.round(integral / seconds)
  })).sort((a, b) => b.liveSeconds - a.liveSeconds || a.id.localeCompare(b.id));
  return {
    daily: records.map(({ viewerSeconds: seconds, viewerIntegral: integral, ...day }) => ({
      ...day, viewerCountAvg: seconds === 0 ? null : Math.round(integral / seconds)
    })),
    totals: records.length === 0 ? null : {
      streamCount: records.reduce((sum, day) => sum + day.streamCount, 0),
      liveSeconds: Math.round(records.reduce((sum, day) => sum + day.liveSeconds, 0)),
      messageCount: records.reduce((sum, day) => sum + day.messageCount, 0),
      viewerCountMax: peaks.length === 0 ? null : Math.max(...peaks),
      viewerCountAvg: viewerSeconds === 0 ? null : Math.round(viewerIntegral / viewerSeconds)
    },
    topCategories: allCategories.slice(0, 4), categoryCount: categories.size,
    categorySeconds: allCategories.reduce((sum, category) => sum + category.liveSeconds, 0),
    viewerSeconds, observationGapSeconds: input.maxGapSeconds
  };
}
