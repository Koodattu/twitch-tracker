import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig(
  ...nextVitals,
  ...nextTypeScript,
  {
    settings: {
      react: { version: "19.2" }
    },
    rules: {
      "@next/next/no-html-link-for-pages": "off"
    }
  },
  {
    files: ["apps/web/**/*.tsx"],
    rules: {
      "@next/next/no-img-element": "off"
    }
  },
  globalIgnores([
    "**/.next/**",
    "**/coverage/**",
    "**/dist/**",
    "**/next-env.d.ts"
  ])
);
