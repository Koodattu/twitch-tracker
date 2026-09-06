import { and, eq, inArray } from "drizzle-orm";
import { communityMapSnapshots, communityMapState, subjectPrivacyStates, twitchUsers, type DbClient } from "@twitch-tracker/db";
import type { CommunityBuildStatus, CommunityMap } from "@twitch-tracker/shared";

export async function getCommunityMap(db: DbClient): Promise<CommunityMap | null> {
  return db.transaction(async (tx) => {
    const [result] = await tx.select({ snapshot: communityMapSnapshots }).from(communityMapState)
      .innerJoin(communityMapSnapshots, and(eq(communityMapState.snapshotId, communityMapSnapshots.id),
        eq(communityMapState.privacyVersion, communityMapSnapshots.privacyVersion), eq(communityMapSnapshots.valid, true)))
      .where(eq(communityMapState.id, "current"));
    const snapshot = result?.snapshot;
    if (snapshot?.graph == null || snapshot.coverage == null) return null;
    const ids = snapshot.graph.nodes.map((node) => node.id);
    const users = ids.length === 0 ? [] : await tx.select({ user: twitchUsers, privacy: subjectPrivacyStates })
      .from(twitchUsers).leftJoin(subjectPrivacyStates, eq(twitchUsers.twitchUserId, subjectPrivacyStates.twitchUserId))
      .where(inArray(twitchUsers.twitchUserId, ids));
    const visible = new Map(users.filter(({ privacy }) => !privacy?.publicProfileHidden && !privacy?.trackingOptedOut && privacy?.dataDeletedAt == null)
      .map(({ user }) => [user.twitchUserId, user]));
    const nodes = snapshot.graph.nodes.filter((node) => visible.has(node.id)).map((node) => {
      const user = visible.get(node.id)!;
      return { ...node, login: user.login, displayName: user.displayName, profileImageUrl: user.profileImageUrl };
    });
    const edges = snapshot.graph.edges.filter((edge) => visible.has(edge.source) && visible.has(edge.target));
    return { recipe: snapshot.recipe, windowStart: snapshot.windowStart.toISOString(), windowEnd: snapshot.windowEnd.toISOString(),
      generatedAt: snapshot.generatedAt.toISOString(), coverage: snapshot.coverage, graph: { nodes, edges } };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function getCommunityBuildStatus(db: DbClient): Promise<CommunityBuildStatus> {
  const [state] = await db.select().from(communityMapState).where(eq(communityMapState.id, "current"));
  return { status: state?.status ?? "idle", requestedAt: state?.requestedAt?.toISOString() ?? null,
    startedAt: state?.startedAt?.toISOString() ?? null, finishedAt: state?.finishedAt?.toISOString() ?? null,
    lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null, error: state?.error ?? null };
}
