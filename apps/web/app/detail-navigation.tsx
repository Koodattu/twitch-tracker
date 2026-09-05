"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function DetailNavigation({ label, links }: { label: string; links: { path: string; label: string }[] }) {
  const pathname = usePathname();
  return <nav className="stream-tabs" aria-label={label}>
    {links.map((link) => <Link key={link.path} href={link.path} prefetch={false} aria-current={pathname === link.path ? "page" : undefined}>{link.label}</Link>)}
  </nav>;
}
