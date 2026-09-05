import { DetailNavigation } from "../../detail-navigation";

export function StreamNavigation({ streamId, canInspectRaw }: { streamId: string; canInspectRaw: boolean }) {
  const base = `/streams/${encodeURIComponent(streamId)}`;
  const links = [{ path: base, label: "Overview" },
    ...(canInspectRaw ? [{ path: `${base}/chat`, label: "Chat" }] : []),
    { path: `${base}/events`, label: "Events" }, { path: `${base}/data`, label: "Data" }];
  return <DetailNavigation label="Stream pages" links={links} />;
}
