import { channelSearchParams, channelViewQuery, readChannelView } from "./channels/[login]/channel-view";

/** Only known channel views and their bounded, canonical filters may be return destinations. */
export function readChannelReturn(value: unknown, today = new Date().toISOString().slice(0, 10)) {
  if (typeof value !== "string" || value.length > 500 || !value.startsWith("/channels/")) return null;
  const url = new URL(value, "https://tracker.invalid");
  const match = /^\/channels\/([a-z0-9_]{1,25})(\/streams)?$/i.exec(url.pathname);
  if (url.origin !== "https://tracker.invalid" || match == null) return null;
  const view = readChannelView(channelSearchParams(url.searchParams), today);
  if (view.invalid) return null;
  const query = new URLSearchParams(channelViewQuery(view));
  if (match[2] != null && url.searchParams.has("page")) {
    const pages = url.searchParams.getAll("page");
    const page = Number(pages[0]);
    if (pages.length !== 1 || !Number.isInteger(page) || page < 1 || page > 100_000) return null;
    if (page > 1) query.set("page", String(page));
  }
  return {
    href: `${url.pathname}${query.size === 0 ? "" : `?${query}`}`,
    login: match[1]!,
    label: match[2] == null ? "Back to channel overview" : "Back to stream history"
  };
}

export function channelStreamHref(streamId: string, returnTo: string) {
  const destination = readChannelReturn(returnTo);
  const base = `/streams/${encodeURIComponent(streamId)}`;
  return destination == null ? base : `${base}?${new URLSearchParams({ returnTo: destination.href })}`;
}
