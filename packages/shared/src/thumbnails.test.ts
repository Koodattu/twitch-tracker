import { describe, expect, it } from "vitest";
import { getSizedThumbnailUrl } from "./index.js";

describe("Twitch thumbnail dimensions", () => {
  it.each(["{width}x{height}", "%{width}x%{height}"])("replaces %s placeholders", (dimensions) => {
    expect(getSizedThumbnailUrl(`https://example.com/image-${dimensions}.jpg`)).toBe("https://example.com/image-640x360.jpg");
  });
  it.each([null, undefined, ""])("preserves an unavailable thumbnail: %s", (value) => {
    expect(getSizedThumbnailUrl(value)).toBeNull();
  });
});
