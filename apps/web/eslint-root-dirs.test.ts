import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const configRequire = createRequire(require.resolve("eslint-config-next"));
const pluginDirectory = dirname(configRequire.resolve("@next/eslint-plugin-next"));
const { getRootDirs } = require(join(pluginDirectory, "utils/get-root-dirs.js")) as {
  getRootDirs(context: { cwd: string; settings: { next?: { rootDir?: string | string[] } } }): string[];
};
const fixture = mkdtempSync(join(tmpdir(), "twitch-eslint-roots-"));
const patternRoot = fixture.replaceAll("\\", "/");
for (const directory of ["alpha/pages", "alpha/nested", "beta/pages"]) {
  mkdirSync(join(fixture, directory), { recursive: true });
}
writeFileSync(join(fixture, "not-a-directory.tsx"), "export default null;");

afterAll(() => {
  if (!resolve(fixture).startsWith(`${resolve(tmpdir())}${sep}twitch-eslint-roots-`)) {
    throw new Error("Unexpected ESLint fixture cleanup path");
  }
  rmSync(fixture, { recursive: true });
});

describe("Next ESLint root-directory discovery", () => {
  it("keeps the current project when rootDir is not configured", () => {
    expect(getRootDirs({ cwd: fixture, settings: {} })).toEqual([fixture]);
  });

  it("keeps a literal directory without expanding its descendants", () => {
    expect(getRootDirs({ cwd: fixture, settings: { next: { rootDir: `${patternRoot}/alpha` } } }))
      .toEqual([`${patternRoot}/alpha`]);
  });

  it.each(["*", "{alpha,beta}", "@(alpha|beta)"])("finds only project directories with %s", (pattern) => {
    expect(getRootDirs({ cwd: fixture, settings: { next: { rootDir: `${patternRoot}/${pattern}` } } }).sort())
      .toEqual([`${patternRoot}/alpha`, `${patternRoot}/beta`]);
  });

  it("supports recursive globs and multiple configured roots", () => {
    const rootDir = [`${patternRoot}/**/pages`, `${patternRoot}/missing`];
    expect(getRootDirs({ cwd: fixture, settings: { next: { rootDir } } }).sort())
      .toEqual([`${patternRoot}/alpha/pages`, `${patternRoot}/beta/pages`]);
  });

  it("preserves relative paths, including roots outside the current directory", () => {
    const relativeRoot = relative(process.cwd(), fixture).replaceAll("\\", "/");
    expect(getRootDirs({ cwd: fixture, settings: { next: { rootDir: `${relativeRoot}/*` } } }).sort())
      .toEqual([`${relativeRoot}/alpha`, `${relativeRoot}/beta`]);
  });

  it("handles deeply nested brace patterns without exhausting the stack", () => {
    const rootDir = `${patternRoot}/${"{".repeat(4_500)}a,b${"}".repeat(4_500)}`;
    expect(getRootDirs({ cwd: fixture, settings: { next: { rootDir } } })).toEqual([]);
  });
});
