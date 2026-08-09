import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "./fetch.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWithTimeout", () => {
  it("adds an abort signal to outbound requests", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response("ok");
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithTimeout("https://example.com", {}, 1_000);

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves an existing abort signal", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      return new Response("ok");
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithTimeout("https://example.com", { signal: controller.signal }, 1_000);
  });
});
