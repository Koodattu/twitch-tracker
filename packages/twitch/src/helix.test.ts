import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchHelixAdapter } from "./helix.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FetchHelixAdapter", () => {
  it("batches Twitch user IDs into one Get Users request", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [] }), {
      headers: { "Content-Type": "application/json" },
      status: 200
    }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new FetchHelixAdapter("client-id");
    await adapter.getUsers({ ids: ["user-1", "user-2"], accessToken: "access-token" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    if (call == null) {
      throw new Error("Expected one Twitch API request.");
    }
    const [input, init] = call;
    const url = new URL(String(input));
    expect(url.pathname).toBe("/helix/users");
    expect(url.searchParams.getAll("id")).toEqual(["user-1", "user-2"]);
    expect(new Headers(init?.headers).get("Client-Id")).toBe("client-id");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access-token");
  });

  it("batches Twitch user IDs into one Get Streams request", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [] }), {
      headers: { "Content-Type": "application/json" },
      status: 200
    }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new FetchHelixAdapter("client-id");
    await adapter.getLiveStreamsByUserIds({ userIds: ["user-1", "user-2"], accessToken: "access-token" });

    const call = fetchMock.mock.calls[0];
    if (call == null) {
      throw new Error("Expected one Twitch API request.");
    }
    const url = new URL(String(call[0]));
    expect(url.pathname).toBe("/helix/streams");
    expect(url.searchParams.getAll("user_id")).toEqual(["user-1", "user-2"]);
    expect(url.searchParams.get("first")).toBe("100");
  });
});
