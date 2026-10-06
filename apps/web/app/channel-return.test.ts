import { describe, expect, it } from "vitest";
import { channelStreamHref, readChannelReturn } from "./channel-return";
import { readStreamView, streamIntervalQuery, streamViewParams, streamViewQuery } from "./streams/[streamId]/stream-view";

const destination = "/channels/channel/streams?days=7&end=2026-09-30&measure=messages&day=2026-09-29&page=2";

describe("channel reporting return path", () => {
  it("retains the reporting scope and page through stream entry, inspection, events and server filters", () => {
    const url = new URL(channelStreamHref("stream", destination), "https://tracker.invalid");
    const view = readStreamView(url.searchParams);
    expect(view.returnTo).toBe(destination);
    const inspection = streamViewQuery({ ...view, at: "2026-09-29T10:00:00.000Z", series: ["viewers"] });
    const interval = streamIntervalQuery(readStreamView(inspection), "2026-09-29T10:00:00.000Z", 5);
    expect(interval.get("returnTo")).toBe(destination);
    expect(interval.get("from")).toBe("2026-09-29T10:00:00.000");
    expect(streamViewParams(Object.fromEntries(interval)).get("returnTo")).toBe(destination);
    expect(readChannelReturn(destination)).toEqual({ href: destination, login: "channel", label: "Back to stream history" });
  });
  it("keeps normal deep links working and canonicalizes an overview return", () => {
    expect(readStreamView(new URLSearchParams()).returnTo).toBeUndefined();
    expect(readChannelReturn("/channels/channel?days=30&measure=viewers&tracking=unrelated#chart")).toEqual({
      href: "/channels/channel", login: "channel", label: "Back to channel overview"
    });
  });
  it.each([
    "https://example.com/channels/channel", "//example.com/channels/channel", "javascript:alert(1)",
    "/channels/../../internal/messages", "/channels/channel/chat", "/channels/channel/streams?page=0",
    "/channels/channel/streams?page=100001", "/channels/channel/streams?page=2&page=3",
    "/channels/channel?days=7&days=90", "/channels/channel?end=2026-02-31", "/channels/" + "a".repeat(501)
  ])("rejects an invalid return destination: %s", (value) => {
    expect(readChannelReturn(value, "2026-10-06")).toBeNull();
  });
  it("ignores repeated return parameters without losing the stream selection", () => {
    const params = new URLSearchParams({ returnTo: destination, at: "2026-09-29T10:00:00.000Z" });
    params.append("returnTo", "/channels/other");
    expect(readStreamView(params)).toMatchObject({ returnTo: undefined, at: "2026-09-29T10:00:00.000Z", invalid: false });
  });
});
