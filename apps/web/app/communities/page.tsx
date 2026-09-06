import type { Metadata } from "next";
import type { CommunityMap } from "@twitch-tracker/shared";
import { getApiData } from "../api-client";
import { EmptyState } from "../ui";
import { CommunityExplorer } from "./community-explorer";

export const metadata: Metadata = { title: "Finnish chat communities" };

export default async function CommunitiesPage() {
  const map = await getApiData<CommunityMap>("/api/communities", { cache: "no-store" });
  return <>
    <section className="page-title page-title-wide">
      <span className="eyebrow">Discover · Finnish Twitch</span>
      <h1>Chat communities</h1>
      <p>Explore the channels connected by the people who chat in them.</p>
    </section>
    {map == null ? <section className="panel"><EmptyState title="Community map unavailable" description="The map is being prepared. Check back after the next build." /></section>
      : <CommunityExplorer map={map} />}
  </>;
}
