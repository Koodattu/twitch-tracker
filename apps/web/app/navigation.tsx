"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Avatar, StatusPill } from "./ui";

export type NavigationViewer = null | {
  login: string | null;
  displayName: string | null;
  profileImageUrl: string | null;
  isAdmin: boolean;
};

export function AppHeader({ viewer, authConfigured, loading = false }: { viewer: NavigationViewer; authConfigured: boolean; loading?: boolean }) {
  const pathname = usePathname();
  const links = [
    { href: "/", label: "Live" },
    { href: "/me", label: viewer == null ? "My data" : "My activity" },
    ...(viewer?.isAdmin === true
      ? [
          { href: "/internal/messages", label: "Messages" },
          { href: "/internal/ingestion", label: "Ingestion" },
          { href: "/internal/bot-accounts", label: "Bots" }
        ]
      : [])
  ];

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link className="brand" href="/" aria-label="Twitch Tracker home">
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          <span>Twitch Tracker</span>
        </Link>

        <nav className="nav" aria-label="Primary navigation">
          {links.map((link) => {
            const isActive = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link className={isActive ? "nav-link nav-link-active" : "nav-link"} href={link.href} key={link.href} aria-current={isActive ? "page" : undefined}>
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="account-area">
          {loading ? (
            <span className="account-skeleton" aria-label="Loading account" />
          ) : viewer == null ? (
            authConfigured ? (
              <a className="button button-compact" href="/api/auth/twitch/start">Log in with Twitch</a>
            ) : (
              <Link className="button button-secondary button-compact" href="/me">Twitch login</Link>
            )
          ) : (
            <Link className="account-link" href="/me">
              <Avatar name={viewer.displayName ?? viewer.login ?? "Twitch user"} src={viewer.profileImageUrl} size="small" />
              <span className="account-copy">
                <strong>{viewer.displayName ?? viewer.login ?? "Twitch user"}</strong>
                <span>{viewer.isAdmin ? "Administrator" : "Own data"}</span>
              </span>
              {viewer.isAdmin ? <StatusPill tone="accent">Admin</StatusPill> : null}
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
