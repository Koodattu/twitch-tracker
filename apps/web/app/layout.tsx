import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import "./globals.css";
import { getApiData } from "./api-client";
import { QueryProvider } from "./query-provider";

export const metadata: Metadata = {
  title: "Twitch Tracker",
  description: "Finnish Twitch stream and channel analytics."
};

type MeResponse = {
  user: null | {
    isAdmin: boolean;
  };
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieHeader = cookies().toString();
  const apiInit: RequestInit = cookieHeader === ""
    ? { cache: "no-store" }
    : { cache: "no-store", headers: { Cookie: cookieHeader } };
  const me = await getApiData<MeResponse>("/api/me", apiInit);
  const isAdmin = me?.user?.isAdmin === true;

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
              {isAdmin ? <Link href="/internal/ingestion">Ingestion</Link> : null}
              {isAdmin ? <Link href="/internal/bot-accounts">Bot accounts</Link> : null}
            </nav>
          </header>
          <main className="shell">{children}</main>
        </QueryProvider>
      </body>
    </html>
  );
}
