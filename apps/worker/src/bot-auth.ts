import { decryptSecret, encryptSecret, type AppConfig } from "@twitch-tracker/config";
import { botAccounts, botAccountTokens, twitchUsers, type DbClient } from "@twitch-tracker/db";
import { refreshTwitchUserAccessToken } from "@twitch-tracker/twitch";
import { and, desc, eq, sql } from "drizzle-orm";

export type ResolvedBotCredentials = {
  botAccountId: string | null;
  twitchUserId: string | null;
  login: string | null;
  accessToken: string | null;
  scopes: string[];
  source: "env" | "database" | "none";
  maxJoinedRooms: number;
  joinRatePer10Seconds: number;
};

export const resolvePrimaryBotCredentials = async (
  db: DbClient,
  config: AppConfig
): Promise<ResolvedBotCredentials> => {
  const envLogin = config.TWITCH_BOT_LOGIN.trim().toLowerCase();
  if (envLogin !== "") {
    if (config.TWITCH_BOT_USER_ID !== "") {
      const now = new Date();
      await db
        .insert(twitchUsers)
        .values({
          twitchUserId: config.TWITCH_BOT_USER_ID,
          login: envLogin,
          displayName: envLogin,
          firstSeenAt: now,
          lastSeenAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: twitchUsers.twitchUserId,
          set: {
            login: envLogin,
            lastSeenAt: now,
            updatedAt: now
          }
        });
    }

    const [bot] = await db
      .insert(botAccounts)
      .values({
        twitchUserId: config.TWITCH_BOT_USER_ID || null,
        login: envLogin,
        enabled: true,
        maxJoinedRooms: config.DEFAULT_BOT_JOIN_CAPACITY,
        joinRatePer10Seconds: config.DEFAULT_BOT_JOIN_RATE_PER_10_SECONDS
      })
      .onConflictDoUpdate({
        target: botAccounts.login,
        set: {
          twitchUserId: config.TWITCH_BOT_USER_ID || null,
          enabled: true,
          maxJoinedRooms: config.DEFAULT_BOT_JOIN_CAPACITY,
          joinRatePer10Seconds: config.DEFAULT_BOT_JOIN_RATE_PER_10_SECONDS,
          updatedAt: new Date()
        }
      })
      .returning({
        id: botAccounts.id,
        maxJoinedRooms: botAccounts.maxJoinedRooms,
        joinRatePer10Seconds: botAccounts.joinRatePer10Seconds
      });

    if (bot == null) {
      throw new Error("Failed to upsert env bot account.");
    }

    if (config.TWITCH_BOT_ACCESS_TOKEN !== "") {
      return {
        botAccountId: bot.id,
        twitchUserId: config.TWITCH_BOT_USER_ID || null,
        login: envLogin,
        accessToken: config.TWITCH_BOT_ACCESS_TOKEN,
        scopes: config.TWITCH_BOT_SCOPES.split(/\s+/).filter(Boolean),
        source: "env",
        maxJoinedRooms: bot.maxJoinedRooms,
        joinRatePer10Seconds: bot.joinRatePer10Seconds
      };
    }

    const dbToken = await findLatestValidToken(db, config, bot.id);
    return {
      botAccountId: bot.id,
      twitchUserId: config.TWITCH_BOT_USER_ID || null,
      login: envLogin,
      accessToken: dbToken?.accessToken ?? null,
      scopes: dbToken?.scopes ?? [],
      source: dbToken == null ? "none" : "database",
      maxJoinedRooms: bot.maxJoinedRooms,
      joinRatePer10Seconds: bot.joinRatePer10Seconds
    };
  }

  const [bot] = await db
    .select({
      id: botAccounts.id,
      twitchUserId: botAccounts.twitchUserId,
      login: botAccounts.login,
      maxJoinedRooms: botAccounts.maxJoinedRooms,
      joinRatePer10Seconds: botAccounts.joinRatePer10Seconds
    })
    .from(botAccounts)
    .where(eq(botAccounts.enabled, true))
    .orderBy(desc(botAccounts.priority), desc(botAccounts.updatedAt))
    .limit(1);

  if (bot == null) {
    return {
      botAccountId: null,
      twitchUserId: null,
      login: null,
      accessToken: null,
      scopes: [],
      source: "none",
      maxJoinedRooms: config.DEFAULT_BOT_JOIN_CAPACITY,
      joinRatePer10Seconds: config.DEFAULT_BOT_JOIN_RATE_PER_10_SECONDS
    };
  }

  const dbToken = await findLatestValidToken(db, config, bot.id);
  return {
    botAccountId: bot.id,
    twitchUserId: bot.twitchUserId,
    login: bot.login,
    accessToken: dbToken?.accessToken ?? null,
    scopes: dbToken?.scopes ?? [],
    source: dbToken == null ? "none" : "database",
    maxJoinedRooms: bot.maxJoinedRooms,
    joinRatePer10Seconds: bot.joinRatePer10Seconds
  };
};

const findLatestValidToken = async (
  db: DbClient,
  config: AppConfig,
  botAccountId: string
): Promise<{ accessToken: string; scopes: string[] } | null> => {
  const [token] = await db
    .select({
      id: botAccountTokens.id,
      scopes: botAccountTokens.scopes,
      encryptedAccessToken: botAccountTokens.encryptedAccessToken,
      encryptedRefreshToken: botAccountTokens.encryptedRefreshToken,
      expiresAt: botAccountTokens.expiresAt
    })
    .from(botAccountTokens)
    .where(
      and(
        eq(botAccountTokens.botAccountId, botAccountId),
        sql`${botAccountTokens.encryptedAccessToken} is not null`
      )
    )
    .orderBy(desc(botAccountTokens.lastValidatedAt), desc(botAccountTokens.updatedAt))
    .limit(1);

  if (token?.encryptedAccessToken == null) {
    return null;
  }

  const now = new Date();
  if (token.expiresAt == null || token.expiresAt > now) {
    try {
      return {
        accessToken: decryptSecret(token.encryptedAccessToken, config.SESSION_SECRET),
        scopes: token.scopes
      };
    } catch {
      await markTokenRefreshStatus(db, token.id, "decrypt_failed");
      return null;
    }
  }

  if (token.encryptedRefreshToken == null || config.TWITCH_CLIENT_ID === "" || config.TWITCH_CLIENT_SECRET === "") {
    return null;
  }

  try {
    const refreshed = await refreshTwitchUserAccessToken({
      clientId: config.TWITCH_CLIENT_ID,
      clientSecret: config.TWITCH_CLIENT_SECRET,
      refreshToken: decryptSecret(token.encryptedRefreshToken, config.SESSION_SECRET)
    });
    const refreshedAt = new Date();
    await db
      .update(botAccountTokens)
      .set({
        scopes: refreshed.scopes,
        encryptedAccessToken: encryptSecret(refreshed.accessToken, config.SESSION_SECRET),
        encryptedRefreshToken: refreshed.refreshToken == null
          ? token.encryptedRefreshToken
          : encryptSecret(refreshed.refreshToken, config.SESSION_SECRET),
        expiresAt: new Date(refreshedAt.getTime() + refreshed.expiresInSeconds * 1000),
        lastValidatedAt: refreshedAt,
        refreshStatus: "refreshed",
        updatedAt: refreshedAt
      })
      .where(eq(botAccountTokens.id, token.id));
    return {
      accessToken: refreshed.accessToken,
      scopes: refreshed.scopes
    };
  } catch {
    await markTokenRefreshStatus(db, token.id, "refresh_failed");
    return null;
  }
};

const markTokenRefreshStatus = async (db: DbClient, tokenId: string, refreshStatus: string) => {
  await db
    .update(botAccountTokens)
    .set({
      refreshStatus,
      updatedAt: new Date()
    })
    .where(eq(botAccountTokens.id, tokenId));
};
