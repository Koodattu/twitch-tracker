import { twitchUsers, type DbClient } from "@twitch-tracker/db";
import type { HelixUser } from "@twitch-tracker/twitch";

export const upsertTwitchUserMetadata = async (
  db: DbClient,
  user: HelixUser,
  observedAt: Date
) => {
  await db
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
      lastSeenAt: observedAt,
      lastMetadataRefreshAt: observedAt,
      updatedAt: observedAt
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
        lastSeenAt: observedAt,
        lastMetadataRefreshAt: observedAt,
        updatedAt: observedAt
      }
    });
};
