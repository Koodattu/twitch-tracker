import { customType } from "drizzle-orm/pg-core";

// Canonical decimal Twitch IDs fit in 4 or 6 bytes. Every other spelling stays
// opaque UTF-8, including leading zeroes. No dictionary lookup is required.
export const encodeExternalKey = (value: string): Buffer => {
  if (/^(0|[1-9][0-9]{0,14})$/.test(value)) {
    const number = Number(value);
    const width = number <= 0xffff_ffff ? 4 : number <= 0xffff_ffff_ffff ? 6 : 0;
    if (width !== 0) {
      const result = Buffer.alloc(width + 1);
      result[0] = width === 4 ? 0 : 1;
      result.writeUIntBE(number, 1, width);
      return result;
    }
  }
  if (!value.isWellFormed()) throw new Error("External identifier must contain valid Unicode.");
  return Buffer.concat([Buffer.from([2]), Buffer.from(value, "utf8")]);
};

export const decodeExternalKey = (value: Buffer): string => {
  if (value[0] === 0 && value.length === 5) return String(value.readUInt32BE(1));
  if (value[0] === 1 && value.length === 7) {
    const number = value.readUIntBE(1, 6);
    if (number <= 0xffff_ffff) throw new Error("Noncanonical compact external identifier.");
    return String(number);
  }
  if (value[0] === 2) {
    const result = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value.subarray(1));
    if (/^(0|[1-9][0-9]{0,14})$/.test(result) && Number(result) <= 0xffff_ffff_ffff) {
      throw new Error("Noncanonical compact external identifier.");
    }
    return result;
  }
  throw new Error("Invalid compact external identifier.");
};

export const compactExternalKey = customType<{ data: string; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: encodeExternalKey,
  fromDriver: decodeExternalKey
});
