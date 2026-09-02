import { ingestionRuns, workerHeartbeats, type DbClient } from "@twitch-tracker/db";

const successfulRunSampleIntervalMs = 60 * 60 * 1000;
const successfulRunSamples = new Map<string, { lastRecordedAt: number; unrecordedRuns: number }>();

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
  let activeRun: Promise<void> | null = null;

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

  const scheduleRun = () => {
    if (input.context.abortSignal.aborted) {
      return;
    }

    if (activeRun != null) {
      void heartbeat(input.context.db, input.context.workerName, input.name, "skipped", {
        reason: "previous run is still active"
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ level: "error", loop: input.name, message }));
      });
      return;
    }

    const task = runSafely();
    activeRun = task;
    const clearActiveRun = () => {
      if (activeRun === task) {
        activeRun = null;
      }
    };
    void task.then(clearActiveRun, clearActiveRun);
  };

  scheduleRun();
  const timer = setInterval(() => {
    scheduleRun();
  }, input.intervalMs);

  return new Promise<void>((resolve) => {
    const stop = () => {
      clearInterval(timer);
      const currentRun = activeRun;
      if (currentRun == null) {
        resolve();
        return;
      }

      void currentRun.then(resolve, resolve);
    };

    if (input.context.abortSignal.aborted) {
      stop();
      return;
    }

    input.context.abortSignal.addEventListener("abort", stop, { once: true });
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
  const startedAt = new Date();

  try {
    const summary = await run();
    const finishedAt = new Date();
    const sample = successfulRunSamples.get(jobType);
    if (sample != null && finishedAt.getTime() - sample.lastRecordedAt < successfulRunSampleIntervalMs) {
      sample.unrecordedRuns += 1;
      return summary;
    }

    await db.insert(ingestionRuns).values({
      jobType,
      status: "succeeded",
      startedAt,
      finishedAt,
      summary: {
        ...summary,
        sampling: {
          intervalMs: successfulRunSampleIntervalMs,
          successfulRuns: (sample?.unrecordedRuns ?? 0) + 1
        }
      }
    });
    successfulRunSamples.set(jobType, {
      lastRecordedAt: finishedAt.getTime(),
      unrecordedRuns: 0
    });
    return summary;
  } catch (error) {
    await db.insert(ingestionRuns).values({
      jobType,
      status: "failed",
      startedAt,
      finishedAt: new Date(),
      errorClass: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};
