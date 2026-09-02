import { describe, expect, it } from "vitest";
import { getFinnishStreamMatchReason } from "./finnish-stream.js";

describe("Finnish stream matching", () => {
  it("prefers Twitch's structured Finnish language", () => {
    expect(getFinnishStreamMatchReason({ language: "FI", tags: [], manuallyPinned: false })).toBe("language");
  });

  it.each(["Suomi", "suomi", "Finnish", "finnish", "  SUOMI  "])(
    "matches the %s tag case-insensitively",
    (tag) => {
      expect(getFinnishStreamMatchReason({ language: "en", tags: [tag], manuallyPinned: false })).toBe("tag");
    }
  );

  it("uses a manual pin only when language and tags do not match", () => {
    expect(getFinnishStreamMatchReason({ language: "other", tags: [], manuallyPinned: true })).toBe("manual");
    expect(getFinnishStreamMatchReason({ language: "other", tags: ["Finnish"], manuallyPinned: true })).toBe("tag");
  });

  it("does not match unrelated tags by substring", () => {
    expect(getFinnishStreamMatchReason({ language: "en", tags: ["SuomiPelit"], manuallyPinned: false })).toBeNull();
  });
});
