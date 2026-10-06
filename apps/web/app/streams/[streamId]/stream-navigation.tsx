"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { DetailNavigation } from "../../detail-navigation";
import { readStreamView, streamViewQuery } from "./stream-view";

export function StreamNavigation({ streamId, canInspectRaw }: { streamId: string; canInspectRaw: boolean }) {
  const base = `/streams/${encodeURIComponent(streamId)}`;
  const links = [{ path: base, label: "Overview" },
    ...(canInspectRaw ? [{ path: `${base}/chat`, label: "Chat" }] : []),
    { path: `${base}/events`, label: "Events" }, { path: `${base}/data`, label: "Data" }];
  return <DetailNavigation label="Stream pages" links={links} preserveSearch={["at", "series", "returnTo"]} />;
}

export function AllStreamEventsLink({ streamId }: { streamId: string }) {
  const query = streamViewQuery(readStreamView(useSearchParams()));
  const base = `/streams/${encodeURIComponent(streamId)}/events`;
  return <Link className="button button-secondary button-compact" href={query.size === 0 ? base : `${base}?${query}`} prefetch={false}>View all events</Link>;
}
