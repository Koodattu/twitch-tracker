import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const requireFromEslint = createRequire(require.resolve("eslint"));

describe("patched lint dependencies", () => {
  it("preserves callable and named minimatch APIs for existing plugins", () => {
    const match = requireFromEslint("minimatch");
    expect(match("apps/web/app/page.tsx", "apps/**/*.tsx")).toBe(true);
    expect(match("apps/api/src/index.ts", "apps/**/*.tsx")).toBe(false);
    expect(match.minimatch(".hidden.ts", "*.ts", { dot: true })).toBe(true);
    expect(new match.Minimatch("**/*.ts").match("packages/db/src/index.ts")).toBe(true);
    expect(match.defaults({ nocase: true })("README.MD", "*.md")).toBe(true);
  });
});
