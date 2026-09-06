import { Worker } from "node:worker_threads";
import { claimCommunityBuild, failCommunityBuild, publishCommunityMap, renewCommunityLease } from "@twitch-tracker/db";
import type { WorkerContext } from "../worker.js";
import type { buildCommunityGraph, CommunityGraphInput } from "../community-graph.js";
import { readCommunityInput } from "../community-input.js";
import { heartbeat, startIntervalLoop } from "./common.js";

export async function runCommunityBuild(context: WorkerContext) {
  const claim = await claimCommunityBuild(context.db);
  if (claim == null) return { skipped: "No build due or another worker owns the build." };
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, context.abortSignal, AbortSignal.timeout(240_000)]);
  let renewal: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (renewal != null) return;
    renewal = (async () => {
      if (!(await renewCommunityLease(context.db, claim))) abort.abort();
      await heartbeat(context.db, context.workerName, "community-map", "running", {});
    })().catch(() => abort.abort()).finally(() => { renewal = null; });
  }, 30_000);
  try {
    const inputStart = performance.now();
    const input = await readCommunityInput(context.db, claim);
    const inputMs = Math.round(performance.now() - inputStart);
    signal.throwIfAborted();
    const graphStart = performance.now();
    const result = await runGraphThread({ memberships: input.memberships, previous: claim.previous }, signal);
    const graphMs = Math.round(performance.now() - graphStart);
    signal.throwIfAborted();
    if (!(await publishCommunityMap(context.db, claim, result.graph, input.coverage))) throw new Error("Community build invalidated before publication");
    return { windowStart: claim.windowStart.toISOString(), windowEnd: claim.windowEnd.toISOString(), inputMs, graphMs,
      payloadBytes: Buffer.byteLength(JSON.stringify(result.graph)),
      channels: result.graph.nodes.length, edges: result.graph.edges.length, ...input.coverage, ...result.diagnostics };
  } catch (error) {
    await failCommunityBuild(context.db, claim);
    throw error;
  } finally {
    clearInterval(timer);
    await renewal;
  }
}

export function runGraphThread(input: CommunityGraphInput, signal: AbortSignal): Promise<ReturnType<typeof buildCommunityGraph>> {
  signal.throwIfAborted();
  const development = import.meta.url.endsWith(".ts");
  const worker = new Worker(new URL(development ? "../community-graph-thread.ts" : "../community-graph-thread.js", import.meta.url), {
    workerData: input, resourceLimits: { maxOldGenerationSizeMb: 512 },
    ...(development ? { execArgv: ["--import", import.meta.resolve("tsx"), "--conditions=development"] } : {})
  });
  return new Promise((resolve, reject) => {
    const stop = () => { void worker.terminate(); reject(new Error("Community graph build cancelled")); };
    signal.addEventListener("abort", stop, { once: true });
    const timeout = setTimeout(stop, 90_000);
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", stop);
      if (code !== 0) reject(new Error("Community graph worker failed"));
    });
  });
}

export const runCommunityMapLoop = (context: WorkerContext) => startIntervalLoop({
  name: "community-map", intervalMs: 30_000, context, run: () => runCommunityBuild(context),
  recordSuccess: (summary) => typeof summary.channels === "number"
});
