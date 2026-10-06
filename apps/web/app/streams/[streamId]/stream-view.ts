import { readChannelReturn } from "../../channel-return";

export const streamSeries = ["viewers", "messagesPerMinute", "activeChatters"] as const;
export type StreamSeries = typeof streamSeries[number];
export type StreamView = { at?: string | undefined; series: StreamSeries[]; returnTo?: string | undefined };

export function readStreamView(search: Pick<URLSearchParams, "getAll">) {
  const times = search.getAll("at");
  const rawTime = times.length === 1 ? times[0] : undefined;
  const date = new Date(rawTime ?? "");
  const at = rawTime != null && Number.isFinite(date.getTime()) && date.toISOString() === rawTime ? rawTime : undefined;
  const values = search.getAll("series");
  const destinations = search.getAll("returnTo");
  const returnTo = readChannelReturn(destinations.length === 1 ? destinations[0] : undefined)?.href;
  const keys = values[0] === "none" ? [] : values[0]?.split(",");
  const validSeries = values.length === 1 && keys != null && new Set(keys).size === keys.length
    && keys.every((key) => streamSeries.includes(key as StreamSeries));
  return {
    at,
    returnTo,
    series: validSeries ? streamSeries.filter((key) => keys.includes(key)) : [...streamSeries],
    invalid: (times.length > 0 && at == null) || (values.length > 0 && !validSeries)
  };
}

export function streamViewQuery(view: StreamView) {
  const query = new URLSearchParams();
  if (view.at != null) query.set("at", view.at);
  if (view.returnTo != null) query.set("returnTo", view.returnTo);
  if (view.series.length !== streamSeries.length) query.set("series", view.series.join(",") || "none");
  return query;
}

export function streamViewParams(search: Record<string, string | string[] | undefined>) {
  return streamViewQuery(readStreamView({ getAll: (key) => {
    const value = search[key];
    return Array.isArray(value) ? value : value == null ? [] : [value];
  } }));
}

export function streamIntervalQuery(view: StreamView, time: string, minutes: number) {
  const query = streamViewQuery({ ...view, at: new Date(time).toISOString() });
  query.set("from", new Date(time).toISOString().slice(0, -1));
  query.set("to", new Date(Date.parse(time) + minutes * 60_000).toISOString().slice(0, -1));
  return query;
}

export function readEventRange(search: Record<string, string | string[] | undefined>) {
  const filters = { from: typeof search.from === "string" ? search.from : "", to: typeof search.to === "string" ? search.to : "" };
  const query = new URLSearchParams();
  let invalid = Array.isArray(search.from) || Array.isArray(search.to);
  for (const key of ["from", "to"] as const) {
    const value = filters[key];
    if (value === "") continue;
    const date = new Date(`${value}Z`);
    const canonical = value.length === 16 ? `${value}:00.000` : value.length === 19 ? `${value}.000` : value.padEnd(23, "0");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)
      || !Number.isFinite(date.getTime()) || date.toISOString() !== `${canonical}Z`) invalid = true;
    else query.set(key, date.toISOString());
  }
  if (query.has("from") && query.has("to") && query.get("from")! >= query.get("to")!) invalid = true;
  return { filters, query, invalid };
}
