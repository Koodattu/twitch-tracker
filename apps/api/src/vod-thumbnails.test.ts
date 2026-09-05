import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "@twitch-tracker/config";
import { createVodThumbnailLookup } from "./vod-thumbnails.js";

const config = loadConfig({
  DATABASE_URL: "postgres://localhost/unused_test", SESSION_SECRET: "s".repeat(48),
  TWITCH_CLIENT_ID: "test-client", TWITCH_CLIENT_SECRET: "test-secret"
});
const video = {
  id: "vod", stream_id: "stream", user_id: "broadcaster", type: "archive", viewable: "public",
  thumbnail_url: "https://static-cdn.jtvnw.net/archive/thumb0-%{width}x%{height}.jpg"
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const mockTwitch = (videos = [video], status = 200) => {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    return new Response(JSON.stringify(url.hostname === "id.twitch.tv"
      ? { access_token: "test-token", expires_in: 3600, token_type: "bearer" }
      : { data: videos }), { status: url.hostname === "id.twitch.tv" ? 200 : status });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("VOD thumbnails", () => {
  it("matches the archive to the exact stream and sizes its Twitch thumbnail", async () => {
    const fetchMock = mockTwitch([{ ...video, stream_id: "newer-stream", thumbnail_url: "https://example.com/wrong.jpg" }, video]);
    const lookup = createVodThumbnailLookup(config);
    expect(await lookup("broadcaster", "stream")).toBe("https://static-cdn.jtvnw.net/archive/thumb0-640x360.jpg");
    const url = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(url.pathname).toBe("/helix/videos");
    expect(Object.fromEntries(url.searchParams)).toEqual({ user_id: "broadcaster", type: "archive", sort: "time", first: "100" });
  });

  it("does not substitute another stream, broadcaster, or nonpublic video", async () => {
    mockTwitch([{ ...video, stream_id: "other" }, { ...video, user_id: "other" }, { ...video, viewable: "private" }]);
    expect(await createVodThumbnailLookup(config)("broadcaster", "stream")).toBeNull();
  });

  it("shares concurrent lookups and refreshes the archive cache after five minutes", async () => {
    vi.useFakeTimers();
    const fetchMock = mockTwitch();
    const lookup = createVodThumbnailLookup(config);
    await Promise.all([lookup("broadcaster", "stream"), lookup("broadcaster", "stream")]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300_001);
    await lookup("broadcaster", "stream");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns no image when Twitch has no archive", async () => {
    mockTwitch([]);
    expect(await createVodThumbnailLookup(config)("broadcaster", "stream")).toBeNull();
  });

  it("backs off after an API error and refreshes a rejected token on retry", async () => {
    vi.useFakeTimers();
    const fetchMock = mockTwitch([], 401);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lookup = createVodThumbnailLookup(config);
    expect(await lookup("broadcaster", "stream")).toBeNull();
    expect(await lookup("broadcaster", "stream")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_001);
    await lookup("broadcaster", "stream");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
