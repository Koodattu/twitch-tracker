import { existsSync } from "node:fs";
import { resolve } from "node:path";

const requiredPaths = [
  "apps/api/package.json",
  "apps/api/src/index.ts",
  "apps/api/src/routes.ts",
  "apps/worker/package.json",
  "apps/worker/src/index.ts",
  "apps/web/package.json",
  "apps/web/app/page.tsx",
  "packages/config/package.json",
  "packages/config/src/index.ts",
  "packages/db/package.json",
  "packages/db/src/schema.ts",
  "packages/twitch/package.json",
  "packages/twitch/src/index.ts",
  "packages/shared/package.json",
  "packages/shared/src/index.ts",
  "compose.yaml",
  "infra/caddy/Caddyfile"
];

const missing = requiredPaths.filter((path) => !existsSync(resolve(path)));

if (missing.length > 0) {
  console.error("Missing required scaffold paths:");
  for (const path of missing) {
    console.error(`- ${path}`);
  }
  process.exit(1);
}

console.log(`Structure check passed (${requiredPaths.length} paths).`);
