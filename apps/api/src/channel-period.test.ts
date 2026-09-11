import { describe, expect, it } from "vitest";
import { summarizeChannelPeriod } from "./channel-period.js";

const at = (value: string) => new Date(`2026-09-${value}Z`);
const session = (id: string, start: string, end: string) => ({ twitchStreamId: id, startedAt: at(start), endedAt: at(end), lastSeenLiveAt: at(end) });
const sample = (id: string, time: string, viewers: number | null, categoryId: string | null = "game", categoryName: string | null = "Game") => ({
  twitchStreamId: id, observedAt: at(time), viewerCount: viewers, categoryId, categoryName
});
const period = (overrides: Partial<Parameters<typeof summarizeChannelPeriod>[0]> = {}) => summarizeChannelPeriod({
  from: at("01T00:00:00"), to: at("03T00:00:00"), maxGapSeconds: 360,
  sessions: [], samples: [], messages: [], ...overrides
});

describe("Channel overview period", () => {
  it("weights the audience by observed seconds, including unequal days and category switches", () => {
    const result = period({
      sessions: [session("one", "01T10:00:00", "01T10:03:00"), session("two", "02T10:00:00", "02T10:09:00")],
      samples: [sample("one", "01T10:00:00", 100), sample("two", "02T10:00:00", 20), sample("two", "02T10:03:00", 40, "chat", "Just Chatting")]
    });
    expect(result.totals).toEqual({ streamCount: 2, liveSeconds: 720, messageCount: 0, viewerCountMax: 100, viewerCountAvg: 50 });
    expect(result.daily.map((day) => day.viewerCountAvg)).toEqual([100, 33]);
    expect(result.viewerSeconds).toBe(720);
    expect(result.categorySeconds).toBe(720);
    expect(result.topCategories).toEqual([
      { id: "chat", name: "Just Chatting", liveSeconds: 360, viewerCountAvg: 40 },
      { id: "game", name: "Game", liveSeconds: 360, viewerCountAvg: 60 }
    ]);
  });

  it("splits cross-midnight intervals and clips streams at both period boundaries", () => {
    const result = period({
      from: at("02T00:00:00"), to: at("02T00:04:00"),
      sessions: [session("one", "01T23:58:00", "02T00:08:00")],
      samples: [sample("one", "01T23:59:00", 10), sample("one", "02T00:02:00", 20)]
    });
    expect(result.daily).toEqual([{ day: "2026-09-02", streamCount: 0, liveSeconds: 240, viewerCountMax: 20, viewerCountAvg: 15, messageCount: 0 }]);
    expect(result.viewerSeconds).toBe(240);
    expect(result.categorySeconds).toBe(240);
    const midnight = period({
      sessions: [session("one", "01T23:58:00", "02T00:02:00")],
      samples: [sample("one", "01T23:58:00", 10)]
    });
    expect(midnight.daily.map((day) => [day.streamCount, day.liveSeconds, day.viewerCountAvg])).toEqual([[1, 120, 10], [0, 120, 10]]);
  });

  it("caps observation gaps without bridging streams or projecting live sessions into the future", () => {
    const result = period({
      sessions: [session("one", "01T10:00:00", "01T12:00:00"), { ...session("two", "01T13:00:00", "01T13:03:00"), endedAt: null }],
      samples: [sample("one", "01T10:00:00", 10), sample("one", "01T11:00:00", 20), sample("two", "01T13:00:00", 30)]
    });
    expect(result.viewerSeconds).toBe(900);
    expect(result.totals?.viewerCountAvg).toBe(18);
    expect(result.totals?.liveSeconds).toBe(7380);
  });

  it("preserves unknown audience and category data while accepting a measured zero", () => {
    const result = period({
      sessions: [session("one", "01T10:00:00", "01T10:09:00")],
      samples: [sample("one", "01T10:00:00", null), sample("one", "01T10:03:00", 0, null, null), sample("one", "01T10:06:00", 60, "", "")]
    });
    expect(result.viewerSeconds).toBe(360);
    expect(result.totals?.viewerCountAvg).toBe(30);
    expect(result.categorySeconds).toBe(180);
    expect(result.topCategories[0]?.viewerCountAvg).toBeNull();
  });

  it("keeps an isolated peak without inventing a duration or time-weighted average", () => {
    const result = period({
      sessions: [{ ...session("one", "01T10:00:00", "01T10:00:00"), endedAt: null }],
      samples: [sample("one", "01T10:00:00", 42)]
    });
    expect(result.totals).toEqual({ streamCount: 1, liveSeconds: 0, messageCount: 0, viewerCountMax: 42, viewerCountAvg: null });
    expect(result.topCategories).toEqual([]);
  });

  it("does not double-count simultaneous observations or count samples from missing sessions", () => {
    const result = period({
      sessions: [session("one", "01T10:00:00", "01T10:03:00")],
      samples: [sample("one", "01T10:00:00", 20), sample("one", "01T10:00:00", 40), sample("missing", "01T10:00:00", 99999)]
    });
    expect(result.viewerSeconds).toBe(180);
    expect(result.totals?.viewerCountAvg).toBe(40);
    expect(result.totals?.viewerCountMax).toBe(40);
  });

  it("keeps the category share denominator complete when only four covers are returned", () => {
    const result = period({
      sessions: [session("one", "01T10:00:00", "01T10:15:00")],
      samples: Array.from({ length: 5 }, (_, index) => sample("one", `01T10:${String(index * 3).padStart(2, "0")}:00`, 20, `game-${index}`, "Same name"))
    });
    expect(result.topCategories).toHaveLength(4);
    expect(result.categoryCount).toBe(5);
    expect(result.categorySeconds).toBe(900);
    expect(result.topCategories[0]!.liveSeconds / result.categorySeconds).toBe(0.2);
  });

  it("bounds captured messages to the same UTC period and keeps empty history empty", () => {
    expect(period().totals).toBeNull();
    expect(period().daily).toEqual([]);
    const result = period({ messages: [
      { day: "2026-08-31", messageCount: 9999 }, { day: "2026-09-01", messageCount: 10 },
      { day: "2026-09-02", messageCount: 20 }, { day: "2026-09-03", messageCount: 9999 }
    ] });
    expect(result.totals?.messageCount).toBe(30);
    expect(result.totals?.viewerCountAvg).toBeNull();
    expect(result.topCategories).toEqual([]);
  });
});
