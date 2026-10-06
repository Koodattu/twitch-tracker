// Local QA harness: explicit synthetic configuration, no inherited credentials.
import { serve } from "../../apps/api/node_modules/@hono/node-server/dist/index.mjs";
import { loadConfig } from "../../packages/config/src/index.js";
import { createDb } from "../../packages/db/src/index.js";
import { createApiApp } from "../../apps/api/src/routes.js";
import { existsSync, readFileSync } from "node:fs";

const databasePort = Number(process.env.GOAL_DATABASE_PORT ?? 55432);
if (!Number.isInteger(databasePort) || databasePort < 1024 || databasePort > 65535) throw new Error("Invalid local QA database port.");

const config = loadConfig({
  DATABASE_URL: `postgres://goal_test:goal_test_local_only@127.0.0.1:${databasePort}/twitch_tracker_goal_ui_test`,
  SESSION_SECRET: "synthetic-local-goal-test-session-secret-only",
  APP_MODE: "local", PUBLIC_WEB_URL: "http://127.0.0.1:3300", PUBLIC_API_URL: "http://127.0.0.1:4400",
  ENABLE_TWITCH_INGESTION: "false", EVENTSUB_ENABLED: "false"
});
const { db, pool } = createDb(config.DATABASE_URL);
const app = createApiApp({ config, db });
const failureFlag = new URL("../../.temp/goal-api-failure", import.meta.url);
const server = serve({ fetch: (request, ...args) => {
  if (existsSync(failureFlag) && new URL(request.url).pathname.startsWith(readFileSync(failureFlag, "utf8").trim())) {
    return new Response("Synthetic QA outage", { status: 503 });
  }
  return app.fetch(request, ...args);
}, hostname: "127.0.0.1", port: 4400 });
console.log(`Synthetic local API on http://127.0.0.1:4400 (PID ${process.pid})`);
process.on("SIGINT", () => server.close(() => { void pool.end(); }));
process.on("SIGTERM", () => server.close(() => { void pool.end(); }));
