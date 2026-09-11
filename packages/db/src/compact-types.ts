import { customType } from "drizzle-orm/pg-core";

export const compactMessageId = customType<{ data: string; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
      ? Buffer.concat([Buffer.from([0]), Buffer.from(value.replaceAll("-", ""), "hex")])
      : Buffer.concat([Buffer.from([1]), Buffer.from(value, "utf8")]);
  },
  fromDriver(value) {
    if (value[0] === 1) return value.subarray(1).toString("utf8");
    if (value[0] !== 0 || value.length !== 17) throw new Error("Invalid compact message identifier.");
    const hex = value.subarray(1).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
});

export const sha256Digest = customType<{ data: string; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver(value) {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
      throw new Error("Membership dedupe key must be a canonical SHA-256 digest.");
    }
    return bytes;
  },
  fromDriver: (value) => value.toString("base64url")
});
