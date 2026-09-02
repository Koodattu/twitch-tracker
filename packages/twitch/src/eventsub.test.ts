import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchEventSubAdapter, isEventSubMessageTimestampFresh, TwitchEventSubApiError } from "./eventsub.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FetchEventSubAdapter", () => {
  it("filters subscription listings by status", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      data: [],
      total: 0,
      total_cost: 0,
      max_total_cost: 10_000,
      pagination: {}
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await new FetchEventSubAdapter("client-id").listSubscriptions({
      accessToken: "access-token",
      status: "enabled"
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("status")).toBe("enabled");
  });

  it("deletes one subscription by ID", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new FetchEventSubAdapter("client-id").deleteSubscription({
      accessToken: "access-token",
      subscriptionId: "subscription-1"
    });

    const call = fetchMock.mock.calls[0];
    expect(call?.[1]?.method).toBe("DELETE");
    expect(new URL(String(call?.[0])).searchParams.get("id")).toBe("subscription-1");
    expect(outcome).toBe("deleted");
  });

  it("exposes rate-limit failures without response bodies", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(null, { status: 429 })));

    await expect(new FetchEventSubAdapter("client-id").deleteSubscription({
      accessToken: "access-token",
      subscriptionId: "subscription-1"
    })).rejects.toEqual(expect.objectContaining<TwitchEventSubApiError>({
      operation: "delete",
      statusCode: 429
    }));
  });
});

describe("isEventSubMessageTimestampFresh", () => {
  const now = new Date("2026-09-03T12:00:00.000Z");

  it("accepts timestamps within the replay window", () => {
    expect(isEventSubMessageTimestampFresh("2026-09-03T11:55:00.123456789Z", now)).toBe(true);
  });

  it("rejects old, future, and malformed timestamps", () => {
    expect(isEventSubMessageTimestampFresh("2026-09-03T11:49:59.999Z", now)).toBe(false);
    expect(isEventSubMessageTimestampFresh("2026-09-03T12:10:00.001Z", now)).toBe(false);
    expect(isEventSubMessageTimestampFresh("not-a-date", now)).toBe(false);
  });
});
