import { customType } from "drizzle-orm/pg-core";

// Version 3 key codes are permanent. Keep this list synchronized with migration 0017.
export const compactBadgeKeys = ["subscriber", "premium", "bits", "moderator", "partner", "broadcaster", "vip", "staff", "founder", "sub-gifter", "artist", "no_audio", "no_video", "turbo", "admin", "global_mod", "glhf-pledge", "bits-leader", "squadsub", "clip-champ"] as const;

export const encodeCompactJson = (value: unknown): Buffer => {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Expected a JSON value.");
  const normalized: unknown = JSON.parse(json);
  if (normalized != null && typeof normalized === "object" && !Array.isArray(normalized)) {
    const entries = Object.entries(normalized);
    if (entries.length === 0) return Buffer.from([0]);
    if (entries.length === 1 && entries[0]![0] === "raw" && typeof entries[0]![1] === "string" && entries[0]![1].isWellFormed()) {
      return Buffer.concat([Buffer.from([1]), Buffer.from(entries[0]![1], "utf8")]);
    }
    const parts: Buffer[] = [Buffer.from([3])];
    const keys: readonly string[] = compactBadgeKeys;
    for (const [key, item] of entries.sort(([a], [b]) => keys.indexOf(a) - keys.indexOf(b))) {
      const code = keys.indexOf(key) + 1;
      if (code === 0 || typeof item !== "string" || !item.isWellFormed()) return Buffer.concat([Buffer.from([2]), Buffer.from(json, "utf8")]);
      const bytes = Buffer.from(item, "utf8");
      if (bytes.length > 255) return Buffer.concat([Buffer.from([2]), Buffer.from(json, "utf8")]);
      parts.push(Buffer.from([code, bytes.length]), bytes);
    }
    return Buffer.concat(parts);
  }
  return Buffer.concat([Buffer.from([2]), Buffer.from(json, "utf8")]);
};

export const decodeCompactJson = (value: Buffer): unknown => {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  if (value[0] === 0 && value.length === 1) return {};
  if (value[0] === 1) return { raw: decoder.decode(value.subarray(1)) };
  if (value[0] === 2) return JSON.parse(decoder.decode(value.subarray(1))) as unknown;
  if (value[0] === 3 && value.length > 1) {
    const result: Record<string, string> = {};
    for (let offset = 1; offset < value.length;) {
      const key = compactBadgeKeys[value[offset]! - 1];
      const length = value[offset + 1];
      if (key == null || length == null || offset + 2 + length > value.length || Object.hasOwn(result, key)) {
        throw new Error("Invalid compact JSON map.");
      }
      result[key] = decoder.decode(value.subarray(offset + 2, offset + 2 + length));
      offset += 2 + length;
    }
    return result;
  }
  throw new Error("Invalid compact JSON encoding.");
};

export const compactJson = <T>() => customType<{ data: T; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: encodeCompactJson,
  fromDriver: (value) => decodeCompactJson(value) as T
});

// The empty physical string represents the common value; ! escapes every other string.
export const compactLabel = (common: string) => customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => value === common ? "" : `!${value}`,
  fromDriver: (value) => {
    if (value === "") return common;
    if (!value.startsWith("!")) throw new Error("Invalid compact label encoding.");
    return value.slice(1);
  }
});
