// Uses only the existing synthetic localhost API; never calls Twitch.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
const phase = process.argv[2] ?? "after";
assert.match(phase, /^(before|after|built)$/);
const evidence = new URL(process.env.GOAL_EVIDENCE_DIR ?? "./evidence/round2/", import.meta.url);
const failureFlag = new URL("../../.temp/goal-api-failure", import.meta.url);
await mkdir(evidence, { recursive: true });
await mkdir(new URL("../../.temp/", import.meta.url), { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce", hasTouch: width < 500 });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("response", response => { if (response.url().startsWith("http://127.0.0.1:") && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
    await page.context().addCookies([{ name: "goal-qa", value: "synthetic", url: "http://127.0.0.1:3300" }]);
    await page.route(/^https?:\/\/(?!127\.0\.0\.1(?=[:/]))/, route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }));
    const go = async path => {
      await page.goto(`http://127.0.0.1:3300${path}`);
      await page.waitForLoadState("networkidle");
      await page.waitForFunction(() => !document.querySelector("main")?.textContent?.includes("Loading analytics"));
    };
    const capture = async name => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no document overflow`);
      await page.screenshot({ path: fileURLToPath(new URL(`${phase}-${name}-${width}.png`, evidence)) });
    };
    await go("/streams/goal-aurora-0");
    const chart = page.getByRole("img", { name: /Stream activity/ });
    await chart.scrollIntoViewIfNeeded();
    const measurements = await chart.evaluate(svg => {
      const label = svg.querySelector(".chart-axis-labels text");
      return {
        chartHeight: svg.getBoundingClientRect().height,
        chartWidth: svg.getBoundingClientRect().width,
        labelRenderedFontPx: parseFloat(getComputedStyle(label).fontSize) * label.getScreenCTM().a
      };
    });
    await capture("chart");
    if (phase !== "before") assert.ok(measurements.labelRenderedFontPx >= 11, `Readable axis labels: ${JSON.stringify(measurements)}`);
    const inspector = page.getByRole("group", { name: "Inspect stream activity", exact: true });
    assert.equal(await page.locator('input[type="range"]').count(), 0);
    await inspector.focus();
    await page.keyboard.press("End");
    const lastIntervalLink = await page.locator(".stream-interval-figures tbody tr").last().getByRole("link").getAttribute("href");
    assert.equal(new URL(page.url()).searchParams.get("at"), new URL(lastIntervalLink, page.url()).searchParams.get("at"));
    assert.match(await page.locator(".stream-chart-values").innerText(), /average.*peak viewers/);
    await page.getByRole("button", { name: "Messages / min", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Messages / min", exact: true }).getAttribute("aria-pressed"), "false");
    await page.getByRole("button", { name: /^Peak audience/ }).click();
    assert.ok(await page.locator(".stream-chart-tooltip strong").isVisible());
    assert.doesNotMatch(await page.locator(".stream-chart-values").innerText(), /Missing observations/);
    await capture("chart-selected");
    const recovery = [];
    for (const scenario of [
      { path: "/streams/goal-aurora-0", api: "/api/streams/goal-aurora-0/overview", heading: "Activity unavailable", success: "Activity over time" },
      { path: "/communities", api: "/api/communities", heading: "Community map unavailable", success: "Chat communities" }
    ]) {
      await writeFile(failureFlag, scenario.api);
      await go(scenario.path);
      assert.ok(await page.getByRole("heading", { name: scenario.heading, exact: true }).isVisible());
      await capture(scenario.path === "/communities" ? "map-unavailable" : "activity-unavailable");
      const retry = page.getByRole("button", { name: "Try again", exact: true });
      const canRetry = await retry.count() === 1;
      await rm(failureFlag);
      if (phase !== "before") {
        assert.ok(canRetry, `${scenario.heading} provides a retry`);
        await retry.click();
        await page.getByRole("heading", { name: scenario.heading, exact: true }).waitFor({ state: "hidden" });
        await page.getByRole("heading", { name: scenario.success, exact: true }).waitFor();
      }
      recovery.push({ page: scenario.path, canRetry });
    }
    assert.deepEqual(errors, []);
    results.push({ width, ...measurements, recovery, errors });
    await page.close();
  }
} finally {
  await rm(failureFlag, { force: true });
  await browser.close();
  await writeFile(new URL(`${phase}-browser.json`, evidence), JSON.stringify(results, null, 2) + "\n");
}
console.log(JSON.stringify(results, null, 2));
