import { existsSync, readFileSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { loadConfig, type AppConfig } from "@twitch-tracker/config";
import {
  eventSubHeaders,
  FetchEventSubAdapter,
  FetchHelixAdapter,
  getTwitchAppAccessToken,
  SocketIrcAdapter,
  validateTwitchAccessToken,
  type ParsedIrcMessage
} from "@twitch-tracker/twitch";

type CheckStatus = "pass" | "warn" | "skip" | "fail";

type Check = {
  name: string;
  status: CheckStatus;
  required: boolean;
  details: Record<string, unknown>;
};

type SmokeOptions = {
  requireLive: boolean;
  eventSubCallback: boolean;
  irc: boolean;
  ircChannel: string | null;
};

const localSmokeDefaults = {
  DATABASE_URL: "postgres://twitch_tracker:twitch_tracker@localhost:5432/twitch_tracker",
  SESSION_SECRET: "local-development-session-secret-000000"
};

const checks: Check[] = [];

const main = async () => {
  loadDotEnvFile();
  const options = parseOptions(process.argv.slice(2));
  const startedAt = new Date();
  let config: AppConfig | null = null;

  try {
    config = loadConfig({ ...localSmokeDefaults, ...process.env });
    record("config", "pass", true, {
      mode: config.APP_MODE,
      ingestionEnabled: config.ENABLE_TWITCH_INGESTION,
      eventSubEnabled: config.EVENTSUB_ENABLED,
      publicApiUrl: config.PUBLIC_API_URL
    });
  } catch (error) {
    record("config", "fail", true, { message: errorMessage(error) });
    finish(startedAt);
    return;
  }

  const appToken = await checkAppCredentials(config, options);
  await checkHelixStreams(config, appToken, options);
  await checkEventSub(config, appToken, options);
  const botValidation = await checkBotToken(config, options);
  await checkBotUser(config, botValidation?.accessToken ?? null, botValidation?.userId ?? null, options);
  await checkIrc(config, options);

  finish(startedAt);
};

const checkAppCredentials = async (config: AppConfig, options: SmokeOptions): Promise<string | null> => {
  const required = options.requireLive;
  if (config.TWITCH_CLIENT_ID === "" || config.TWITCH_CLIENT_SECRET === "") {
    record("twitch_app_token", "skip", required, { reason: "TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET is not configured." });
    return null;
  }

  try {
    const token = await withTimeout(
      getTwitchAppAccessToken({
        clientId: config.TWITCH_CLIENT_ID,
        clientSecret: config.TWITCH_CLIENT_SECRET
      }),
      15_000,
      "Twitch app token request timed out."
    );
    record("twitch_app_token", "pass", required, {
      tokenType: token.tokenType,
      expiresInSeconds: token.expiresInSeconds
    });
    return token.accessToken;
  } catch (error) {
    record("twitch_app_token", "fail", required, { message: errorMessage(error) });
    return null;
  }
};

const checkHelixStreams = async (config: AppConfig, appAccessToken: string | null, options: SmokeOptions) => {
  const required = options.requireLive;
  if (appAccessToken == null) {
    record("helix_finnish_streams", "skip", required, { reason: "App access token is unavailable." });
    return;
  }

  try {
    const helix = new FetchHelixAdapter(config.TWITCH_CLIENT_ID);
    const response = await withTimeout(
      helix.getLiveStreamsByLanguage({
        language: "fi",
        first: 1,
        accessToken: appAccessToken
      }),
      15_000,
      "Helix streams request timed out."
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      record("helix_finnish_streams", "fail", required, {
        statusCode: response.statusCode,
        requestParams: response.requestParams
      });
      return;
    }

    record("helix_finnish_streams", "pass", required, {
      statusCode: response.statusCode,
      streamsReturned: response.responseJson.data.length,
      rateLimitRemaining: response.rateLimit.remaining,
      rateLimitResetAt: response.rateLimit.resetAt?.toISOString() ?? null
    });
  } catch (error) {
    record("helix_finnish_streams", "fail", required, { message: errorMessage(error) });
  }
};

const checkEventSub = async (config: AppConfig, appAccessToken: string | null, options: SmokeOptions) => {
  const callbackUrl = new URL("/api/webhooks/twitch/eventsub", config.PUBLIC_API_URL).toString();
  const callbackUrlRequired = config.EVENTSUB_ENABLED || options.eventSubCallback;

  if (!config.EVENTSUB_ENABLED && !options.eventSubCallback) {
    record("eventsub_callback_url", "skip", false, {
      reason: "EVENTSUB_ENABLED is false.",
      callbackUrl
    });
  } else {
    const parsedCallback = new URL(callbackUrl);
    const isPublicHttps = parsedCallback.protocol === "https:" && (parsedCallback.port === "" || parsedCallback.port === "443");
    record("eventsub_callback_url", isPublicHttps ? "pass" : "fail", callbackUrlRequired, {
      callbackUrl,
      requirement: "EventSub webhook callback must be public HTTPS on port 443."
    });
  }

  if (appAccessToken == null) {
    record("eventsub_list_subscriptions", "skip", config.EVENTSUB_ENABLED, { reason: "App access token is unavailable." });
  } else {
    try {
      const eventSub = new FetchEventSubAdapter(config.TWITCH_CLIENT_ID);
      const page = await withTimeout(
        eventSub.listSubscriptions({ accessToken: appAccessToken }),
        15_000,
        "EventSub subscription list request timed out."
      );
      record("eventsub_list_subscriptions", "pass", config.EVENTSUB_ENABLED, {
        total: page.total,
        totalCost: page.totalCost,
        maxTotalCost: page.maxTotalCost
      });
    } catch (error) {
      record("eventsub_list_subscriptions", "fail", config.EVENTSUB_ENABLED, { message: errorMessage(error) });
    }
  }

  if (!options.eventSubCallback) {
    record("eventsub_signed_challenge", "skip", false, { reason: "Pass --eventsub-callback to POST a signed challenge to the configured API." });
    return;
  }

  await checkEventSubCallback(config, callbackUrl);
};

const checkEventSubCallback = async (config: AppConfig, callbackUrl: string) => {
  const challenge = `smoke-${randomUUID()}`;
  const body = JSON.stringify({
    challenge,
    subscription: {
      id: `smoke-${randomUUID()}`,
      type: "stream.online",
      version: "1",
      status: "webhook_callback_verification_pending",
      condition: {
        broadcaster_user_id: config.TWITCH_BOT_USER_ID || "0"
      },
      transport: {
        method: "webhook",
        callback: callbackUrl
      },
      created_at: new Date().toISOString()
    }
  });
  const messageId = `smoke-${randomUUID()}`;
  const timestamp = new Date().toISOString();
  const signature = `sha256=${createHmac("sha256", config.TWITCH_EVENTSUB_SECRET)
    .update(messageId + timestamp + body)
    .digest("hex")}`;

  try {
    const response = await withTimeout(
      fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [eventSubHeaders.messageId]: messageId,
          [eventSubHeaders.messageTimestamp]: timestamp,
          [eventSubHeaders.messageSignature]: signature,
          [eventSubHeaders.messageType]: "webhook_callback_verification",
          [eventSubHeaders.subscriptionType]: "stream.online",
          [eventSubHeaders.subscriptionVersion]: "1"
        },
        body
      }),
      15_000,
      "EventSub callback request timed out."
    );
    const responseText = await response.text();
    record("eventsub_signed_challenge", response.ok && responseText === challenge ? "pass" : "fail", true, {
      callbackUrl,
      statusCode: response.status,
      matchedChallenge: responseText === challenge
    });
  } catch (error) {
    record("eventsub_signed_challenge", "fail", true, { callbackUrl, message: errorMessage(error) });
  }
};

const checkBotToken = async (
  config: AppConfig,
  options: SmokeOptions
): Promise<{ accessToken: string; userId: string | null } | null> => {
  const required = options.requireLive;
  if (config.TWITCH_BOT_LOGIN === "" || config.TWITCH_BOT_ACCESS_TOKEN === "") {
    record("bot_token_validation", "skip", required, { reason: "TWITCH_BOT_LOGIN or TWITCH_BOT_ACCESS_TOKEN is not configured." });
    return null;
  }

  try {
    const validation = await withTimeout(
      validateTwitchAccessToken(config.TWITCH_BOT_ACCESS_TOKEN),
      15_000,
      "Twitch bot token validation timed out."
    );
    const expectedLogin = config.TWITCH_BOT_LOGIN.toLowerCase();
    const loginMatches = validation.login == null || validation.login.toLowerCase() === expectedLogin;
    const clientMatches = config.TWITCH_CLIENT_ID === "" || validation.clientId === config.TWITCH_CLIENT_ID;
    const userMatches = config.TWITCH_BOT_USER_ID === "" || validation.userId === config.TWITCH_BOT_USER_ID;

    record("bot_token_validation", loginMatches && clientMatches && userMatches ? "pass" : "fail", required, {
      login: validation.login,
      userId: validation.userId,
      scopes: validation.scopes,
      expiresInSeconds: validation.expiresInSeconds,
      loginMatches,
      clientMatches,
      userMatches
    });

    return loginMatches && clientMatches && userMatches
      ? { accessToken: config.TWITCH_BOT_ACCESS_TOKEN, userId: validation.userId }
      : null;
  } catch (error) {
    record("bot_token_validation", "fail", required, { message: errorMessage(error) });
    return null;
  }
};

const checkBotUser = async (config: AppConfig, botAccessToken: string | null, botUserId: string | null, options: SmokeOptions) => {
  const required = options.requireLive;
  if (botAccessToken == null || config.TWITCH_CLIENT_ID === "") {
    record("bot_helix_user", "skip", required, { reason: "Validated bot access token or TWITCH_CLIENT_ID is unavailable." });
    return;
  }

  try {
    const helix = new FetchHelixAdapter(config.TWITCH_CLIENT_ID);
    const response = await withTimeout(
      helix.getUsers({
        ids: botUserId == null ? [] : [botUserId],
        logins: botUserId == null ? [config.TWITCH_BOT_LOGIN] : [],
        accessToken: botAccessToken
      }),
      15_000,
      "Helix bot user request timed out."
    );

    const ok = response.statusCode >= 200 && response.statusCode < 300 && response.responseJson.data.length > 0;
    record("bot_helix_user", ok ? "pass" : "fail", required, {
      statusCode: response.statusCode,
      usersReturned: response.responseJson.data.length,
      login: response.responseJson.data[0]?.login ?? null,
      userId: response.responseJson.data[0]?.id ?? null
    });
  } catch (error) {
    record("bot_helix_user", "fail", required, { message: errorMessage(error) });
  }
};

const checkIrc = async (config: AppConfig, options: SmokeOptions) => {
  const shouldRun = options.irc || options.requireLive;
  if (!shouldRun) {
    record("irc_login", "skip", false, { reason: "Pass --irc or --require-live to test Twitch IRC login." });
    return;
  }

  if (config.TWITCH_BOT_LOGIN === "" || config.TWITCH_BOT_ACCESS_TOKEN === "") {
    record("irc_login", "skip", options.requireLive, { reason: "TWITCH_BOT_LOGIN or TWITCH_BOT_ACCESS_TOKEN is not configured." });
    return;
  }

  const messages: ParsedIrcMessage[] = [];
  let latestError: string | null = null;
  let disconnectedReason: string | null = null;
  const adapter = new SocketIrcAdapter({
    login: config.TWITCH_BOT_LOGIN,
    oauthToken: config.TWITCH_BOT_ACCESS_TOKEN,
    events: {
      rawMessage: (message) => {
        messages.push(message);
      },
      error: (error) => {
        latestError = error.message;
      },
      disconnected: (reason) => {
        disconnectedReason = reason;
      }
    }
  });

  try {
    await withTimeout(adapter.connect(), 15_000, "Twitch IRC connection timed out.");
    const authResult = await waitForIrcAuth(messages, () => latestError, 8_000);
    if (authResult.status === "fail") {
      await adapter.disconnect("smoke_auth_failed").catch(() => undefined);
      record("irc_login", "fail", options.requireLive, authResult.details);
      return;
    }

    const channel = (options.ircChannel ?? config.TWITCH_BOT_LOGIN).toLowerCase();
    await adapter.join(channel);
    const joined = await waitForIrcJoin(messages, channel, 5_000);
    await adapter.disconnect("smoke_complete").catch(() => undefined);

    record("irc_login", authResult.status, options.requireLive, {
      channel,
      observedWelcome: authResult.details.observedWelcome,
      observedJoinOrRoomState: joined,
      rawMessagesObserved: messages.length,
      disconnectedReason
    });
  } catch (error) {
    await adapter.disconnect("smoke_error").catch(() => undefined);
    record("irc_login", "fail", options.requireLive, { message: errorMessage(error), rawMessagesObserved: messages.length });
  }
};

const waitForIrcAuth = async (
  messages: ParsedIrcMessage[],
  latestError: () => string | null,
  timeoutMs: number
): Promise<{ status: "pass" | "fail"; details: Record<string, unknown> }> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const error = latestError();
    if (error != null) {
      return { status: "fail", details: { message: error } };
    }

    const authNotice = messages.find((message) =>
      message.command === "NOTICE" && (message.trailing ?? "").toLowerCase().includes("authentication")
    );
    if (authNotice != null) {
      return { status: "fail", details: { message: authNotice.trailing ?? "IRC authentication failed." } };
    }

    if (messages.some((message) => message.command === "001")) {
      return { status: "pass", details: { observedWelcome: true } };
    }

    await sleep(250);
  }

  return { status: "fail", details: { message: "Timed out waiting for Twitch IRC welcome.", observedWelcome: false } };
};

const waitForIrcJoin = async (messages: ParsedIrcMessage[], channel: string, timeoutMs: number): Promise<boolean> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (
      messages.some((message) =>
        (message.command === "JOIN" || message.command === "ROOMSTATE" || message.command === "USERSTATE") &&
        message.params.some((param) => param.toLowerCase() === `#${channel}`)
      )
    ) {
      return true;
    }
    await sleep(250);
  }

  return false;
};

const record = (name: string, status: CheckStatus, required: boolean, details: Record<string, unknown>) => {
  checks.push({ name, status, required, details });
};

const finish = (startedAt: Date) => {
  const finishedAt = new Date();
  const failedRequired = checks.filter((check) => check.required && (check.status === "fail" || check.status === "skip"));
  const payload = {
    ok: failedRequired.length === 0,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    checks
  };

  console.log(JSON.stringify(payload, null, 2));
  if (failedRequired.length > 0) {
    process.exitCode = 1;
  }
};

const parseOptions = (args: string[]): SmokeOptions => {
  const options: SmokeOptions = {
    requireLive: false,
    eventSubCallback: false,
    irc: false,
    ircChannel: null
  };

  for (const arg of args) {
    if (arg === "--require-live") {
      options.requireLive = true;
    } else if (arg === "--eventsub-callback") {
      options.eventSubCallback = true;
    } else if (arg === "--irc") {
      options.irc = true;
    } else if (arg.startsWith("--irc-channel=")) {
      options.ircChannel = arg.slice("--irc-channel=".length).trim().toLowerCase() || null;
    }
  }

  return options;
};

const loadDotEnvFile = () => {
  const envPath = [".env", "../../.env"].find((candidate) => existsSync(candidate));
  if (envPath == null) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator < 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (key === "" || process.env[key] != null) {
      continue;
    }

    process.env[key] = stripEnvQuotes(rawValue);
  }
};

const stripEnvQuotes = (value: string) => {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer != null) {
      clearTimeout(timer);
    }
  }
};

const sleep = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const errorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(error);
};

void main().catch((error: unknown) => {
  record("unexpected_error", "fail", true, { message: errorMessage(error) });
  finish(new Date());
});
