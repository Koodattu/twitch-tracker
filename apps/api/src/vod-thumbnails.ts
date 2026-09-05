import type { AppConfig } from "@twitch-tracker/config";
import { getSizedThumbnailUrl } from "@twitch-tracker/shared";
import { FetchHelixAdapter, getTwitchAppAccessToken, type HelixVideo } from "@twitch-tracker/twitch";

export const createVodThumbnailLookup = (config: AppConfig) => {
  const helix = new FetchHelixAdapter(config.TWITCH_CLIENT_ID);
  const cache = new Map<string, { expiresAt: number; videos: Promise<HelixVideo[]> }>();
  let token: Promise<{ accessToken: string; expiresAt: number }> | null = null;

  const getAccessToken = async () => {
    const previous = token;
    if (previous != null && (await previous).expiresAt <= Date.now() && token === previous) {
      token = null;
    }
    token ??= getTwitchAppAccessToken({
      clientId: config.TWITCH_CLIENT_ID,
      clientSecret: config.TWITCH_CLIENT_SECRET
    }).then((value) => ({
      accessToken: value.accessToken,
      expiresAt: Date.now() + Math.max(0, value.expiresInSeconds - 60) * 1000
    })).catch((error: unknown) => {
      token = null;
      throw error;
    });
    return (await token).accessToken;
  };

  return async (broadcasterId: string, streamId: string): Promise<string | null> => {
    if (config.TWITCH_CLIENT_ID === "" || config.TWITCH_CLIENT_SECRET === "") {
      return null;
    }

    let entry = cache.get(broadcasterId);
    if (entry == null || entry.expiresAt <= Date.now()) {
      for (const [key, value] of cache) {
        if (value.expiresAt <= Date.now()) cache.delete(key);
      }
      const oldest = cache.keys().next().value;
      if (cache.size >= 100 && oldest != null) cache.delete(oldest);

      entry = {
        expiresAt: Date.now() + 60_000,
        videos: getAccessToken().then(async (accessToken) => {
          const response = await helix.getArchivedVideos({ userId: broadcasterId, accessToken });
          if (response.statusCode !== 200) {
            if (response.statusCode === 401) token = null;
            throw new Error(`Twitch archive lookup returned ${response.statusCode}`);
          }
          const current = cache.get(broadcasterId);
          if (current != null) current.expiresAt = Date.now() + 300_000;
          return response.responseJson.data;
        }).catch(() => {
          console.warn(JSON.stringify({ level: "warn", message: "Twitch archive thumbnails are temporarily unavailable" }));
          return [];
        })
      };
      cache.set(broadcasterId, entry);
    }

    const video = (await entry.videos).find((item) =>
      item.stream_id === streamId && item.user_id === broadcasterId && item.type === "archive" && item.viewable === "public"
    );
    return getSizedThumbnailUrl(video?.thumbnail_url);
  };
};
