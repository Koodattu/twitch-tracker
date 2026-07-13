import type { Metadata } from "next";
import "./globals.css";
import { getApiData, getAuthenticatedApiInit } from "./api-client";
import { AppHeader, type NavigationViewer } from "./navigation";
import { QueryProvider } from "./query-provider";

export const metadata: Metadata = {
  title: {
    default: "Twitch Tracker",
    template: "%s · Twitch Tracker"
  },
  description: "Live Finnish Twitch stream, channel, and chat activity analytics."
};

type MeResponse = {
  user: NavigationViewer;
  authConfigured: boolean;
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const apiInit = await getAuthenticatedApiInit();
  const me = await getApiData<MeResponse>("/api/me", apiInit);

  return (
    <html lang="en">
      <body>
        <QueryProvider>
          <a className="skip-link" href="#main-content">Skip to content</a>
          <AppHeader viewer={me?.user ?? null} authConfigured={me?.authConfigured ?? false} />
          <main className="shell" id="main-content">{children}</main>
        </QueryProvider>
      </body>
    </html>
  );
}
