import { decryptSecret, encryptSecret } from "@twitch-tracker/config";
import { oauthAccounts, twitchUsers } from "@twitch-tracker/db";
import { FetchHelixAdapter, refreshTwitchUserAccessToken, validateTwitchAccessToken, type TwitchUserToken } from "@twitch-tracker/twitch";
import { desc, eq } from "drizzle-orm";
import type { WorkerContext } from "../worker.js";
import { startIntervalLoop } from "./common.js";

export const runUserHydrationLoop = (context: WorkerContext) => {
  startIntervalLoop({
    name: "user-hydration",
    intervalMs: context.config.USER_HYDRATION_INTERVAL_MS,
    context,
    run: async () => {
      if (context.config.TWITCH_CLIENT_ID === "" || context.config.TWITCH_CLIENT_SECRET === "") {
        return {
          hydratedUsers: 0,
          skipped: "TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET is not configured."
        };
      }

      const accounts = await context.db
        .select()
        .from(oauthAccounts)
        .where(eq(oauthAccounts.provider, "twitch"))
        .orderBy(desc(oauthAccounts.updatedAt))
        .limit(50);

      let validatedUsers = 0;
      let refreshedTokens = 0;
      let hydratedUsers = 0;
      let failedAccounts = 0;
      for (const account of accounts) {
        if (account.encryptedAccessToken == null) {
          continue;
        }

        try {
          const result = await validateOrRefreshAccount(context, account);
          validatedUsers += 1;
          refreshedTokens += result.refreshed ? 1 : 0;
          hydratedUsers += result.hydrated ? 1 : 0;
        } catch (error) {
          failedAccounts += 1;
          await context.db
            .update(oauthAccounts)
            .set({
              refreshStatus: "failed",
              latestError: error instanceof Error ? error.message : String(error),
              updatedAt: new Date()
            })
            .where(eq(oauthAccounts.id, account.id));
        }
      }

      return {
        checkedAccounts: accounts.length,
        validatedUsers,
        refreshedTokens,
        hydratedUsers,
        failedAccounts
      };
    }
  });
};

const validateOrRefreshAccount = async (
  context: WorkerContext,
  account: typeof oauthAccounts.$inferSelect
): Promise<{ refreshed: boolean; hydrated: boolean }> => {
  let accessToken = decryptSecret(account.encryptedAccessToken ?? "", context.config.SESSION_SECRET);
  let refreshedToken: TwitchUserToken | null = null;

  try {
    await validateTwitchAccessToken(accessToken);
  } catch {
    if (account.encryptedRefreshToken == null) {
      throw new Error("OAuth access token is invalid and no refresh token is stored.");
    }

    refreshedToken = await refreshTwitchUserAccessToken({
      clientId: context.config.TWITCH_CLIENT_ID,
      clientSecret: context.config.TWITCH_CLIENT_SECRET,
      refreshToken: decryptSecret(account.encryptedRefreshToken, context.config.SESSION_SECRET)
    });
    accessToken = refreshedToken.accessToken;
  }

  const validation = await validateTwitchAccessToken(accessToken);
  if (validation.userId == null) {
    throw new Error("Validated OAuth token is not associated with a Twitch user.");
  }

  const expiresAt = new Date(Date.now() + validation.expiresInSeconds * 1000);
  await context.db
    .update(oauthAccounts)
    .set({
      scopes: validation.scopes,
      encryptedAccessToken: refreshedToken == null ? account.encryptedAccessToken : encryptSecret(refreshedToken.accessToken, context.config.SESSION_SECRET),
      encryptedRefreshToken: refreshedToken?.refreshToken == null
        ? account.encryptedRefreshToken
        : encryptSecret(refreshedToken.refreshToken, context.config.SESSION_SECRET),
      expiresAt,
      lastValidatedAt: new Date(),
      refreshStatus: refreshedToken == null ? "valid" : "refreshed",
      latestError: null,
      updatedAt: new Date()
    })
    .where(eq(oauthAccounts.id, account.id));

  const helix = new FetchHelixAdapter(context.config.TWITCH_CLIENT_ID);
  const response = await helix.getUsers({
    ids: [validation.userId],
    accessToken
  });
  const user = response.responseJson.data[0];
  if (response.statusCode < 200 || response.statusCode >= 300 || user == null) {
    return {
      refreshed: refreshedToken != null,
      hydrated: false
    };
  }

  const now = new Date();
  await context.db
    .insert(twitchUsers)
    .values({
      twitchUserId: user.id,
      login: user.login,
      displayName: user.display_name,
      accountType: user.type,
      broadcasterType: user.broadcaster_type,
      description: user.description,
      profileImageUrl: user.profile_image_url,
      offlineImageUrl: user.offline_image_url,
      twitchCreatedAt: new Date(user.created_at),
      lastSeenAt: now,
      lastMetadataRefreshAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: twitchUsers.twitchUserId,
      set: {
        login: user.login,
        displayName: user.display_name,
        accountType: user.type,
        broadcasterType: user.broadcaster_type,
        description: user.description,
        profileImageUrl: user.profile_image_url,
        offlineImageUrl: user.offline_image_url,
        twitchCreatedAt: new Date(user.created_at),
        lastSeenAt: now,
        lastMetadataRefreshAt: now,
        updatedAt: now
      }
    });

  return {
    refreshed: refreshedToken != null,
    hydrated: true
  };
};
