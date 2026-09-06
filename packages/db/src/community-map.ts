import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { communityMapRecipe, type CommunityCoverage, type CommunityGraph } from "@twitch-tracker/shared";
import type { DbClient } from "./index.js";
import { communityMapSnapshots, communityMapState, jobLocks } from "./schema.js";

const lockName = "community-map";
const dayMs = 86_400_000;
export type CommunityBuildClaim = {
  owner: string;
  requestVersion: number;
  privacyVersion: number;
  windowStart: Date;
  windowEnd: Date;
  previous: CommunityGraph | null;
};

export function communityWindow(now: Date, manual = false) {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const end = midnight - (!manual && now.getUTCHours() < 3 ? dayMs : 0);
  return { windowStart: new Date(end - 30 * dayMs), windowEnd: new Date(end) };
}

export async function requestCommunityBuild(db: DbClient) {
  await db.execute(sql`
    update community_map_state set
      request_version = case when request_version > completed_version then request_version else request_version + 1 end,
      requested_at = now(), retry_after = null, error = null,
      status = case when status = 'building' then status else 'queued' end
    where id = 'current'
  `);
}

// The caller holds the privacy-effects transaction, so invalidation and subject changes commit together.
export async function invalidateCommunityMaps(db: Pick<DbClient, "execute">) {
  await db.execute(sql`
    update community_map_state set privacy_version = privacy_version + 1,
      request_version = request_version + 1, snapshot_id = null, status = 'queued',
      requested_at = now(), retry_after = null, error = null where id = 'current'
  `);
  await db.execute(sql`update community_map_snapshots set valid = false, graph = null, coverage = null where valid = true`);
}

export async function claimCommunityBuild(db: DbClient, now = new Date()): Promise<CommunityBuildClaim | null> {
  return db.transaction(async (tx) => {
    const [state] = await tx.select().from(communityMapState).where(eq(communityMapState.id, "current")).for("update");
    if (state == null || (state.retryAfter != null && state.retryAfter > now)) return null;
    const pending = state.requestVersion > state.completedVersion;
    const window = communityWindow(now, pending);
    const [previous] = state.snapshotId == null ? [] : await tx.select().from(communityMapSnapshots)
      .where(eq(communityMapSnapshots.id, state.snapshotId));
    if (!pending && previous?.valid && previous.recipe === communityMapRecipe && previous.windowEnd >= window.windowEnd) return null;
    const owner = randomUUID();
    const lease = await tx.execute(sql`
      insert into job_locks (name, owner, locked_at, expires_at)
      values (${lockName}, ${owner}, now(), now() + interval '4 minutes')
      on conflict (name) do update set owner = excluded.owner, locked_at = excluded.locked_at,
        expires_at = excluded.expires_at, updated_at = now()
      where job_locks.expires_at <= now()
      returning owner
    `);
    if (lease.rows.length === 0) return null;
    await tx.update(communityMapState).set({ status: "building", startedAt: now, error: null }).where(eq(communityMapState.id, "current"));
    return { ...window, owner, requestVersion: state.requestVersion, privacyVersion: state.privacyVersion, previous: previous?.graph ?? null };
  });
}

export async function renewCommunityLease(db: DbClient, claim: CommunityBuildClaim) {
  const result = await db.execute(sql`
    update job_locks set expires_at = now() + interval '4 minutes', updated_at = now()
    where name = ${lockName} and owner = ${claim.owner} and expires_at > now() returning owner
  `);
  return result.rows.length === 1;
}

export async function publishCommunityMap(db: DbClient, claim: CommunityBuildClaim, graph: CommunityGraph, coverage: CommunityCoverage) {
  return db.transaction(async (tx) => {
    const [state] = await tx.select().from(communityMapState).where(eq(communityMapState.id, "current")).for("update");
    const [lease] = await tx.select().from(jobLocks).where(and(eq(jobLocks.name, lockName), eq(jobLocks.owner, claim.owner), gt(jobLocks.expiresAt, new Date()))).for("update");
    if (lease == null || state == null || state.privacyVersion !== claim.privacyVersion) return false;
    const generatedAt = new Date();
    const values = { recipe: communityMapRecipe, windowStart: claim.windowStart, windowEnd: claim.windowEnd,
      generatedAt, privacyVersion: claim.privacyVersion, valid: true, graph, coverage };
    const [snapshot] = await tx.insert(communityMapSnapshots).values(values).onConflictDoUpdate({
      target: [communityMapSnapshots.recipe, communityMapSnapshots.windowEnd], set: values
    }).returning({ id: communityMapSnapshots.id });
    await tx.update(communityMapState).set({
      snapshotId: snapshot!.id, completedVersion: claim.requestVersion,
      status: state.requestVersion > claim.requestVersion ? "queued" : "ready",
      finishedAt: generatedAt, lastSuccessAt: generatedAt, retryAfter: null, error: null
    }).where(eq(communityMapState.id, "current"));
    await tx.delete(jobLocks).where(and(eq(jobLocks.name, lockName), eq(jobLocks.owner, claim.owner)));
    return true;
  });
}

export async function failCommunityBuild(db: DbClient, claim: CommunityBuildClaim) {
  await db.transaction(async (tx) => {
    const [state] = await tx.select().from(communityMapState).where(eq(communityMapState.id, "current")).for("update");
    const [lease] = await tx.select().from(jobLocks).where(and(eq(jobLocks.name, lockName), eq(jobLocks.owner, claim.owner))).for("update");
    if (state == null || lease == null) return;
    const pending = state.requestVersion > claim.requestVersion || state.privacyVersion !== claim.privacyVersion;
    await tx.update(communityMapState).set({ status: pending ? "queued" : "failed", finishedAt: new Date(),
      retryAfter: pending ? null : new Date(Date.now() + 15 * 60_000),
      error: pending ? null : "The map could not be rebuilt. Another attempt will run automatically."
    }).where(eq(communityMapState.id, "current"));
    await tx.delete(jobLocks).where(and(eq(jobLocks.name, lockName), eq(jobLocks.owner, claim.owner)));
  });
}
