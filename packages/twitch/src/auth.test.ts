import { afterEach, describe, expect, it, vi } from "vitest";
import { validateTwitchAccessToken } from "./auth.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateTwitchAccessToken", () => {
  it("normalizes null scopes to an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      client_id: "client-id",
      login: "example-user",
      scopes: null,
      user_id: "123456",
      expires_in: 3600
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));

    const validation = await validateTwitchAccessToken("access-token");

    expect(validation.scopes).toEqual([]);
  });
});
