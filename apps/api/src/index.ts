import { serve } from "@hono/node-server";
import { loadConfig } from "@twitch-tracker/config";
import { createDb } from "@twitch-tracker/db";
import { createApiApp } from "./routes.js";

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const app = createApiApp({ config, db });

const port = Number(process.env.PORT ?? 4000);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(JSON.stringify({ level: "info", message: "api listening", port: info.port }));
});

let shutdownPromise: Promise<void> | null = null;

const shutdown = async (signal: string) => {
  shutdownPromise ??= (async () => {
    console.log(JSON.stringify({ level: "info", message: "api shutting down", signal }));
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error == null) resolve();
        else reject(error);
      });
      const closeIdleConnections = (server as { closeIdleConnections?: () => void }).closeIdleConnections;
      closeIdleConnections?.call(server);
    });
    await pool.end();
  })();

  await shutdownPromise;
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
