import { describe, expect, it } from "vitest";
import { decodeCompactJson, encodeCompactJson } from "./compact-metadata.js";

const metadataFixtures: unknown[] = [
  {}, { raw: "" }, { raw: "25:0-4/😀 ä\n\ufeff" }, { raw: "\ufeffleading BOM" },
  { subscriber: "12", premium: "1", moderator: "1" },
  { founder: "", artist: "\ufeff😀" }, { subscriber: "x".repeat(255) },
  { subscriber: "x".repeat(256) }, { subscriber: "😀".repeat(64) },
  { custom: "badge", subscriber: "1" }, { raw: "", other: [1, false, null] },
  { subscriber: 1 }, { nested: { raw: "x", subscriber: "2" } },
  ["array", { raw: "" }], null, true, 42, "scalar"
];

describe("Compact metadata", () => {
  it.each(metadataFixtures.map((value, index) => ({ value, index })))("preserves JSON fixture $index", ({ value }) => {
    expect(decodeCompactJson(encodeCompactJson(value))).toEqual(value);
  });

  it("uses compact empty, raw and badge representations", () => {
    expect(encodeCompactJson({}).length).toBe(1);
    expect(encodeCompactJson({ raw: "" }).length).toBe(1);
    expect(encodeCompactJson({ subscriber: "12", premium: "1" }).length).toBe(8);
  });

  it.each([[], [0, 0], [3], [3, 1], [3, 1, 2, 65], [3, 21, 0], [3, 1, 0, 1, 0], [1, 255], [4]])("rejects malformed bytes %j", (...bytes) => {
    expect(() => decodeCompactJson(Buffer.from(bytes))).toThrow();
  });
});
