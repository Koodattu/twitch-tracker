import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    await page.goto("http://127.0.0.1:3300/streams/goal-aurora-0");
    await page.waitForLoadState("networkidle");
    const chart = page.getByRole("group", { name: "Inspect stream activity", exact: true });
    await chart.focus();
    await page.keyboard.press("End");
    const at = new URL(page.url()).searchParams.get("at");
    const selected = await page.locator(".stream-chart-values").innerText();
    await page.getByRole("link", { name: "Chat", exact: true }).click();
    await page.getByLabel("Chatter login", { exact: true }).fill("testichat");
    await page.getByRole("button", { name: "Filter chat", exact: true }).click();
    await page.waitForURL(/chatter=testichat/);
    await page.waitForLoadState("networkidle");
    assert.equal(new URL(page.url()).searchParams.get("at"), at, "Chat filters preserve selected time");
    await page.getByRole("link", { name: "Load older", exact: true }).click();
    await page.waitForURL(/page=2/);
    assert.equal(new URL(page.url()).searchParams.get("at"), at, "Chat pagination preserves selected time");
    await page.getByRole("link", { name: "Clear", exact: true }).click();
    await page.waitForURL(url => !url.searchParams.has("chatter"));
    assert.equal(new URL(page.url()).searchParams.get("at"), at, "Clear removes chat filters only");
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    await chart.waitFor();
    assert.equal(await page.locator(".stream-chart-values").innerText(), selected);
    results.push({ width, filtersPaginationClearAndReturn: true });
    await page.close();
  }
} finally { await browser.close(); }
await writeFile(new URL("./evidence/round5/built-stream-context.json", import.meta.url), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results));
