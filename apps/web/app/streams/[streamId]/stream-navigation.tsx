"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function StreamNavigation({ streamId, canInspectRaw }: { streamId: string; canInspectRaw: boolean }) {
  const pathname = usePathname();
  const base = `/streams/${encodeURIComponent(streamId)}`;
  const links = [{ path: base, label: "Overview" },
    ...(canInspectRaw ? [{ path: `${base}/chat`, label: "Chat" }] : []),
    { path: `${base}/events`, label: "Events" }, { path: `${base}/data`, label: "Data" }];
  return <nav className="stream-tabs" aria-label="Stream pages">
    {links.map((link) => <Link key={link.path} href={link.path} prefetch={false} aria-current={pathname === link.path ? "page" : undefined}>{link.label}</Link>)}
  </nav>;
}
