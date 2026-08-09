import { defineConfig } from "drizzle-kit";
import { readFileSync } from "node:fs";

const databaseUrl = process.env.DATABASE_URL
  ?? (process.env.DATABASE_URL_FILE == null ? undefined : readFileSync(process.env.DATABASE_URL_FILE, "utf8").trimEnd())
  ?? "postgres://twitch_tracker:twitch_tracker@localhost:5432/twitch_tracker";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: databaseUrl
  }
});
