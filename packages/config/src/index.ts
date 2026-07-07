import { appModes } from "@twitch-tracker/shared";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";

const optionalUrl = z.string().url().or(z.literal("")).optional();

const booleanFromString = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((value) => value === "true" || value === "1");

const intFromString = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value == null || value === "" ? defaultValue : Number(value)))
    .pipe(z.number().int().nonnegative());

export const baseEnvSchema = z.object({
  APP_MODE: z.enum(appModes).default("local"),
  PUBLIC_WEB_URL: z.string().url().default("http://localhost:3000"),
  PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  INTERNAL_API_URL: z.string().url().default("http://localhost:4000"),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  SESSION_TTL_DAYS: intFromString(30),
  COOKIE_SECURE: booleanFromString,
  TWITCH_CLIENT_ID: z.string().optional().default(""),
  TWITCH_CLIENT_SECRET: z.string().optional().default(""),
  TWITCH_OAUTH_REDIRECT_URI: optionalUrl,
  TWITCH_LOGIN_SCOPES: z.string().optional().default(""),
  TWITCH_EVENTSUB_SECRET: z.string().min(32).optional().default("replace-with-at-least-32-random-characters"),
  EVENTSUB_ENABLED: booleanFromString,
  EVENTSUB_MAX_CHANNELS: intFromString(25),
  TWITCH_BOT_USER_ID: z.string().optional().default(""),
  TWITCH_BOT_LOGIN: z.string().optional().default(""),
  TWITCH_BOT_ACCESS_TOKEN: z.string().optional().default(""),
  TWITCH_BOT_REFRESH_TOKEN: z.string().optional().default(""),
  ENABLE_TWITCH_INGESTION: booleanFromString,
  DEFAULT_BOT_JOIN_CAPACITY: intFromString(100),
  DEFAULT_BOT_JOIN_RATE_PER_10_SECONDS: intFromString(20),
  DISCOVERY_INTERVAL_MS: intFromString(60_000),
  USER_HYDRATION_INTERVAL_MS: intFromString(300_000),
  ASSIGNMENT_INTERVAL_MS: intFromString(30_000),
  AGGREGATION_INTERVAL_MS: intFromString(60_000),
  AGGREGATION_BUCKET_MINUTES: intFromString(5),
  AGGREGATION_LOOKBACK_HOURS: intFromString(48),
  MAINTENANCE_INTERVAL_MS: intFromString(300_000),
  RAW_CHAT_RETENTION_DAYS: intFromString(30),
  RAW_PAYLOAD_RETENTION_DAYS: intFromString(30),
  STALE_ASSIGNMENT_GRACE_MINUTES: intFromString(15),
  BACKUP_RETENTION_DAYS: intFromString(14)
});

export type AppConfig = z.infer<typeof baseEnvSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  return baseEnvSchema.parse(env);
};

export const isPrivateDataMode = (mode: AppConfig["APP_MODE"]): boolean => {
  return mode === "local" || mode === "private_mvp";
};

const deriveKey = (secret: string, purpose: string): Buffer => {
  return createHash("sha256").update(`${purpose}:${secret}`).digest();
};

export const hashSessionToken = (sessionToken: string, secret: string): string => {
  return createHmac("sha256", deriveKey(secret, "session-hash")).update(sessionToken).digest("base64url");
};

export const encryptSecret = (value: string, secret: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret, "token-encryption"), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
};

export const decryptSecret = (encryptedValue: string, secret: string): string => {
  const [version, iv, tag, ciphertext] = encryptedValue.split(".");
  if (version !== "v1" || iv == null || tag == null || ciphertext == null) {
    throw new Error("Unsupported encrypted secret format.");
  }

  const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret, "token-encryption"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
};

export const parseScopeList = (scopeList: string): string[] => {
  return scopeList
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
};
