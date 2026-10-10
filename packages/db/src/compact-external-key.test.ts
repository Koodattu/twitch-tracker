import { describe, expect, it } from "vitest";
import { decodeExternalKey, encodeExternalKey } from "./compact-external-key.js";

describe("compact external identifiers", () => {
  it.each(["0", "1", "123456789", "4294967295", "4294967296", "50000000000", "281474976710655",
    "281474976710656", "000123", "-1", "+1", "1e3", "", "opaque 😀", "\ufeffchannel", "999999999999999999999999"])(
    "preserves exact spelling of %s", value => {
      expect(decodeExternalKey(encodeExternalKey(value))).toBe(value);
    });

  it("uses fixed-width numeric payloads with canonical boundaries", () => {
    expect(encodeExternalKey("4294967295")).toEqual(Buffer.from("00ffffffff", "hex"));
    expect(encodeExternalKey("4294967296")).toEqual(Buffer.from("01000100000000", "hex"));
    expect(encodeExternalKey("281474976710655")).toEqual(Buffer.from("01ffffffffffff", "hex"));
    expect(encodeExternalKey("281474976710656")[0]).toBe(2);
    expect(encodeExternalKey("000123")).not.toEqual(encodeExternalKey("123"));
  });

  it.each(["", "00", "01000000000001", "02313233", "02ff", "03"])("rejects corrupt or alternate encoding %s", hex => {
    expect(() => decodeExternalKey(Buffer.from(hex, "hex"))).toThrow();
  });
});
