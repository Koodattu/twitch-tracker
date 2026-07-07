import { ingestionRuns, workerHeartbeats, type DbClient } from "@twitch-tracker/db";
import { eq, and } from "drizzle-orm";

export type LoopContext = {
  db: DbClient;
  workerName: string;
  abortSignal: AbortSignal;
};

export const startIntervalLoop = (input: {
  name: string;
  intervalMs: number;
  context: LoopContext;
  run: () => Promise<Record<string, unknown>>;
}) => {
  const runSafely = async () => {
    if (input.context.abortSignal.aborted) {
      return;
    }

    await runWithIngestionRecord(input.context.db, input.name, async () => {
      await heartbeat(input.context.db, input.context.workerName, input.name, "running", {});
      const summary = await input.run();
      await heartbeat(input.context.db, input.context.workerName, input.name, "ok", summary);
      return summary;
    }).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      await heartbeat(input.context.db, input.context.workerName, input.name, "error", { message });
      console.error(JSON.stringify({ level: "error", loop: input.name, message }));
    });
  };

  void runSafely();
  const timer = setInterval(() => {
    void runSafely();
  }, input.intervalMs);

  input.context.abortSignal.addEventListener("abort", () => {
    clearInterval(timer);
  });
};

export const heartbeat = async (
  db: DbClient,
  workerName: string,
  loopName: string,
  status: string,
  details: Record<string, unknown>
) => {
  await db
    .insert(workerHeartbeats)
    .values({
      workerName,
      loopName,
      status,
      details,
      lastHeartbeatAt: new Date()
    })
    .onConflictDoUpdate({
      target: [workerHeartbeats.workerName, workerHeartbeats.loopName],
      set: {
        status,
        details,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date()
      }
    });
};

export const runWithIngestionRecord = async (
  db: DbClient,
  jobType: string,
  run: () => Promise<Record<string, unknown>>
) => {
  const [created] = await db
    .insert(ingestionRuns)
    .values({ jobType, status: "running", startedAt: new Date() })
    .returning({ id: ingestionRuns.id });

  if (created == null) {
    throw new Error(`Failed to create ingestion run for ${jobType}.`);
  }

  try {
    const summary = await run();
    await db
      .update(ingestionRuns)
      .set({
        status: "succeeded",
        finishedAt: new Date(),
        summary,
        updatedAt: new Date()
      })
      .where(eq(ingestionRuns.id, created.id));
    return summary;
  } catch (error) {
    await db
      .update(ingestionRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        errorClass: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
        updatedAt: new Date()
      })
      .where(and(eq(ingestionRuns.id, created.id)));
    throw error;
  }
};
