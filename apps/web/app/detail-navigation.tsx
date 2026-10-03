"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

export function DetailNavigation({ label, links, preserveSearch = [] }: { label: string; links: { path: string; label: string }[]; preserveSearch?: string[] }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const query = new URLSearchParams();
  for (const key of preserveSearch) {
    const value = search.get(key);
    if (value != null) query.set(key, value);
  }
  return <nav className="stream-tabs" aria-label={label}>
    {links.map((link) => <Link key={link.path} href={query.size === 0 ? link.path : `${link.path}?${query}`} prefetch={false} aria-current={pathname === link.path ? "page" : undefined}>{link.label}</Link>)}
  </nav>;
}
