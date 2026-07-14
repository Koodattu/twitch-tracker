import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { getApiData, getAuthenticatedApiInit } from "./api-client";
import { AppHeader, type NavigationViewer } from "./navigation";

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <Suspense fallback={<AppHeader viewer={null} authConfigured={false} loading />}>
          <ViewerHeader />
        </Suspense>
        <main className="shell" id="main-content">{children}</main>
      </body>
    </html>
  );
}

async function ViewerHeader() {
  const apiInit = await getAuthenticatedApiInit();
  const me = await getApiData<MeResponse>("/api/me", apiInit);

  return <AppHeader viewer={me?.user ?? null} authConfigured={me?.authConfigured ?? false} />;
}
