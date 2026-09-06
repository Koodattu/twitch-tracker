import type { DbClient } from "@twitch-tracker/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithIngestionRecord } from "./common.js";

const createDb = () => {
  const values = vi.fn(async () => undefined);
  const db = {
    insert: vi.fn(() => ({ values }))
  } as unknown as DbClient;
  return { db, values };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("runWithIngestionRecord", () => {
  it("samples successful runs hourly and records the represented run count", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T10:00:00Z"));
    const { db, values } = createDb();
    const jobType = `sampling-${crypto.randomUUID()}`;

    await runWithIngestionRecord(db, jobType, async () => ({ sequence: 1 }));
    vi.setSystemTime(new Date("2026-09-02T10:30:00Z"));
    await runWithIngestionRecord(db, jobType, async () => ({ sequence: 2 }));
    vi.setSystemTime(new Date("2026-09-02T11:00:00Z"));
    await runWithIngestionRecord(db, jobType, async () => ({ sequence: 3 }));

    expect(values).toHaveBeenCalledTimes(2);
    expect(values).toHaveBeenLastCalledWith(expect.objectContaining({
      jobType,
      status: "succeeded",
      summary: {
        sequence: 3,
        sampling: {
          intervalMs: 3_600_000,
          successfulRuns: 2
        }
      }
    }));
  });

  it("records completed community builds even when due checks were recently sampled", async () => {
    const { db, values } = createDb();
    const jobType = `community-${crypto.randomUUID()}`;
    const recordBuild = (summary: Record<string, unknown>) => typeof summary.channels === "number";
    await runWithIngestionRecord(db, jobType, async () => ({ skipped: "No build due" }), recordBuild);
    await runWithIngestionRecord(db, jobType, async () => ({ channels: 12 }), recordBuild);
    await runWithIngestionRecord(db, jobType, async () => ({ channels: 0 }), recordBuild);
    expect(values).toHaveBeenCalledTimes(3);
    expect(values).toHaveBeenLastCalledWith(expect.objectContaining({ summary: expect.objectContaining({ channels: 0 }) }));
  });

  it("records every failed run", async () => {
    const { db, values } = createDb();
    const failure = new Error("test failure");

    await expect(runWithIngestionRecord(db, `failure-${crypto.randomUUID()}`, async () => {
      throw failure;
    })).rejects.toBe(failure);

    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      errorClass: "Error",
      errorMessage: "test failure"
    }));
  });
});
