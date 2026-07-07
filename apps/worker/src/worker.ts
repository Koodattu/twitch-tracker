import type { AppConfig } from "@twitch-tracker/config";
import type { DbClient } from "@twitch-tracker/db";
import { DisabledHelixAdapter, FetchHelixAdapter, type TwitchRestAdapter } from "@twitch-tracker/twitch";
import { runAggregationLoop } from "./loops/aggregation.js";
import { runAssignmentLoop } from "./loops/assignment.js";
import { runChattersReconciliationLoop } from "./loops/chatters-reconciliation.js";
import { runDiscoveryLoop } from "./loops/discovery.js";
import { runEventSubLoop } from "./loops/eventsub.js";
import { runIrcLoop } from "./loops/irc.js";
import { runMaintenanceLoop } from "./loops/maintenance.js";
import { runUserHydrationLoop } from "./loops/user-hydration.js";

export type WorkerContext = {
  config: AppConfig;
  db: DbClient;
  rest: TwitchRestAdapter;
  workerName: string;
  abortSignal: AbortSignal;
};

type CreateWorkerInput = {
  config: AppConfig;
  db: DbClient;
};

export const createWorker = ({ config, db }: CreateWorkerInput) => {
  const abortController = new AbortController();
  const rest = createRestAdapter(config);
  const context: WorkerContext = {
    config,
    db,
    rest,
    workerName: process.env.WORKER_NAME ?? "worker-1",
    abortSignal: abortController.signal
  };

  return {
    async start() {
      console.log(JSON.stringify({ level: "info", message: "worker starting", mode: config.APP_MODE }));
      runDiscoveryLoop(context);
      runUserHydrationLoop(context);
      runAssignmentLoop(context);
      runIrcLoop(context);
      runChattersReconciliationLoop(context);
      runEventSubLoop(context);
      runAggregationLoop(context);
      runMaintenanceLoop(context);
    },
    async stop(reason: string) {
      abortController.abort(reason);
    }
  };
};

const createRestAdapter = (config: AppConfig): TwitchRestAdapter => {
  if (!config.ENABLE_TWITCH_INGESTION || config.TWITCH_CLIENT_ID === "") {
    return new DisabledHelixAdapter();
  }

  return new FetchHelixAdapter(config.TWITCH_CLIENT_ID);
};
