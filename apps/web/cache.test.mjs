import { mkdtemp, readdir, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import nextConfig from "./next.config.mjs";

const require = createRequire(import.meta.url);
const { default: FileSystemCache } = require("next/dist/server/lib/incremental-cache/file-system-cache.js");

// Exercise the pinned Next.js implementation: isrFlushToDisk is experimental.
test("fetch cache evicts old entries without filling the container filesystem", async () => {
  const directory = await mkdtemp(join(tmpdir(), "twitch-web-cache-"));
  try {
    const cache = new FileSystemCache({
      fs,
      serverDistDir: join(directory, "server"),
      flushToDisk: nextConfig.experimental.isrFlushToDisk,
      maxMemoryCacheSize: nextConfig.cacheMaxMemorySize,
      revalidatedTags: []
    });
    const context = { kind: "FETCH", tags: [], softTags: [], fetchCache: true };
    const value = {
      kind: "FETCH",
      data: { headers: {}, body: "x".repeat(1024 * 1024), status: 200, url: "http://example.test" },
      revalidate: 15
    };
    await cache.set("first", value, context);
    expect((await cache.get("first", context))?.value).toEqual(value);

    for (let index = 0; index < 64; index++) {
      await cache.set(`page-${index}`, value, context);
    }
    expect(await cache.get("first", context)).toBeNull();
    expect((await cache.get("page-63", context))?.value).toEqual(value);
    expect(await readdir(directory)).toEqual([]);

    await cache.revalidateTag("changed");
    expect(await cache.get("page-63", { ...context, tags: ["changed"] })).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
