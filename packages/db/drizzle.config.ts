import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL
  ?? "postgres://twitch_tracker:twitch_tracker@localhost:5432/twitch_tracker";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: databaseUrl
  }
});
