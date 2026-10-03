import { channelPeriodDays, earliestChannelPeriodEnd, isChannelDay, type ChannelPeriodDays } from "@twitch-tracker/shared";

export type ChannelView = { days: ChannelPeriodDays; end: string | undefined; measure: "viewers" | "messages"; day: string | undefined };
export type ChannelSearch = Record<string, string | string[] | undefined>;

export function channelSearchParams(search: Pick<URLSearchParams, "keys" | "getAll">): ChannelSearch {
  return Object.fromEntries([...new Set(search.keys())].map((key) => {
    const values = search.getAll(key);
    return [key, values.length === 1 ? values[0] : values];
  }));
}

export function readChannelView(search: ChannelSearch, today: string): ChannelView & { invalid: boolean } {
  const validDays = typeof search.days === "string" && channelPeriodDays.includes(Number(search.days) as ChannelPeriodDays);
  const days = validDays ? Number(search.days) as ChannelPeriodDays : 30;
  const end = isChannelDay(search.end, today) && search.end >= earliestChannelPeriodEnd ? search.end : undefined;
  const toDay = end ?? today;
  const fromDay = new Date(Date.parse(toDay) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const day = isChannelDay(search.day, today) && search.day >= fromDay && search.day <= toDay ? search.day : undefined;
  return {
    days, end, day, measure: search.measure === "messages" ? "messages" : "viewers",
    invalid: (search.days != null && !validDays) || (search.end != null && end == null)
      || (search.day != null && day == null) || (search.measure != null && search.measure !== "viewers" && search.measure !== "messages")
  };
}

export function channelViewQuery(view: ChannelView) {
  const query = new URLSearchParams();
  if (view.days !== 30) query.set("days", String(view.days));
  if (view.end != null) query.set("end", view.end);
  if (view.measure !== "viewers") query.set("measure", view.measure);
  if (view.day != null) query.set("day", view.day);
  return query.toString();
}
