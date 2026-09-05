import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // PostgreSQL integration suites reset shared test tables.
    fileParallelism: process.env.TEST_DATABASE_URL == null,
    exclude: [...configDefaults.exclude, "**/dist/**"]
  }
});
