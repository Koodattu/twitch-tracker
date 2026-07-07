import { loadConfig } from "@twitch-tracker/config";
import { createDb } from "@twitch-tracker/db";
import { createWorker } from "./worker.js";

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const worker = createWorker({ config, db });

await worker.start();

const shutdown = async (signal: string) => {
  console.log(JSON.stringify({ level: "info", message: "worker shutting down", signal }));
  await worker.stop(signal);
  await pool.end();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
