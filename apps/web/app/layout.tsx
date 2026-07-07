import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { QueryProvider } from "./query-provider";

export const metadata: Metadata = {
  title: "Twitch Tracker",
  description: "Finnish Twitch stream and channel analytics."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <QueryProvider>
          <header className="topbar">
            <Link className="brand" href="/">
              Twitch Tracker
            </Link>
            <nav className="nav" aria-label="Primary navigation">
              <Link href="/">Live</Link>
              <Link href="/me">Own data</Link>
              <Link href="/internal/ingestion">Ingestion</Link>
            </nav>
          </header>
          <main className="shell">{children}</main>
        </QueryProvider>
      </body>
    </html>
  );
}
