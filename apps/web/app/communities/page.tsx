import type { Metadata } from "next";
import type { CommunityMap } from "@twitch-tracker/shared";
import { getApiData } from "../api-client";
import { EmptyState } from "../ui";
import { CommunityExplorer } from "./community-explorer";

export const metadata: Metadata = { title: "Finnish chat communities" };

export default async function CommunitiesPage() {
  const map = await getApiData<CommunityMap>("/api/communities", { cache: "no-store" });
  return <section className="community-stage" aria-label="Chat communities">
    {map == null ? <div className="community-empty community-glass"><h1>Chat communities</h1><EmptyState title="Community map unavailable" description="The map is being prepared. Check back after the next build." /></div>
      : <CommunityExplorer map={map} />}
  </section>;
}
