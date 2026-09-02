import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

const productionEnv = (): NodeJS.ProcessEnv => ({
  APP_MODE: "production",
  PUBLIC_WEB_URL: "https://tracker.example.com",
  PUBLIC_API_URL: "https://tracker.example.com",
  INTERNAL_API_URL: "http://api:4000",
  DATABASE_URL: "postgres://tracker:password@postgres:5432/tracker",
  SESSION_SECRET: "s".repeat(48),
  COOKIE_SECURE: "true",
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TWITCH_OAUTH_REDIRECT_URI: "https://tracker.example.com/api/auth/twitch/callback",
  TWITCH_EVENTSUB_SECRET: "e".repeat(48),
  ADMIN_TWITCH_USER_IDS: "123456"
});

describe("production configuration", () => {
  it("accepts a secure same-origin configuration", () => {
    const config = loadConfig(productionEnv());
    expect(config.APP_MODE).toBe("production");
    expect(config.KNOWN_CHANNEL_DISCOVERY_INTERVAL_MS).toBe(900_000);
    expect(config.STREAM_END_GRACE_MINUTES).toBe(20);
    expect(config.EVENTSUB_PROCESSING_INTERVAL_MS).toBe(5_000);
    expect(config.EVENTSUB_RECONCILIATION_INTERVAL_MS).toBe(60_000);
    expect(config.EVENTSUB_MAX_DELETIONS_PER_RUN).toBe(500);
    expect(config.EVENTSUB_MAX_CREATIONS_PER_RUN).toBe(100);
    expect(config.BROADCASTER_METADATA_REFRESH_INTERVAL_MS).toBe(86_400_000);
    expect(config.AGGREGATION_INTERVAL_MS).toBe(300_000);
  });

  it("rejects different public origins", () => {
    expect(() => loadConfig({ ...productionEnv(), PUBLIC_API_URL: "https://api.example.com" }))
      .toThrow(/same origin/);
  });

  it("rejects production without an administrator", () => {
    expect(() => loadConfig({ ...productionEnv(), ADMIN_TWITCH_USER_IDS: "", ADMIN_TWITCH_LOGINS: "" }))
      .toThrow(/administrator/);
  });

  it("rejects zero-length worker intervals", () => {
    expect(() => loadConfig({ ...productionEnv(), DISCOVERY_INTERVAL_MS: "0" })).toThrow();
  });
});
