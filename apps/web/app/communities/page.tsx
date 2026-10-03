import type { Metadata } from "next";
import type { CommunityMap } from "@twitch-tracker/shared";
import { getApiData, getAuthenticatedApiInit } from "../api-client";
import { EmptyState } from "../ui";
import { RetryButton } from "../retry-button";
import { CommunityExplorer } from "./community-explorer";

export const metadata: Metadata = { title: "Finnish chat communities" };

export default async function CommunitiesPage() {
  const init = await getAuthenticatedApiInit();
  const [map, viewer] = await Promise.all([
    getApiData<CommunityMap>("/api/communities", { cache: "no-store" }),
    getApiData<{ user: null | { isAdmin: boolean } }>("/api/me", init)
  ]);
  return <section className="community-stage" aria-label="Chat communities">
    {map == null ? <div className="community-empty community-glass"><h1>Chat communities</h1><EmptyState title="Community map unavailable" description="The map could not be loaded. Try again to reconnect." action={<RetryButton />} /></div>
      : <CommunityExplorer map={map} canLookupChatter={viewer?.user?.isAdmin === true} />}
  </section>;
}
