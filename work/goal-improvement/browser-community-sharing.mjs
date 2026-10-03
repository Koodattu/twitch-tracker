import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
const phase = process.argv[2] ?? "built";
const evidence = new URL("./evidence/round5/", import.meta.url);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  for (const width of [1440, 768, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, reducedMotion: "reduce", hasTouch: width < 500 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto("http://127.0.0.1:3300/communities");
    await page.waitForLoadState("networkidle");
    await page.getByRole("searchbox", { name: "Search channels" }).fill("Aurora");
    await page.getByRole("button", { name: /AuroraPelaa 45/ }).click();
    const details = page.getByRole("region", { name: "Selected channel" });
    assert.ok(await details.getByRole("heading", { name: "AuroraPelaa", exact: true }).isVisible());
    const selectedUrl = page.url();
    await page.reload();
    await page.waitForLoadState("networkidle");
    if (phase === "before") {
      assert.equal(await details.count(), 0);
    } else {
      assert.ok(await details.getByRole("heading", { name: "AuroraPelaa", exact: true }).isVisible(), "Reload restores selected channel");
      assert.equal(new URL(selectedUrl).searchParams.get("channel"), "goal-aurora");
      await details.getByRole("button", { name: /SisuLive/ }).click();
      assert.ok(await details.getByRole("heading", { name: "SisuLive", exact: true }).isVisible());
      await page.goBack();
      assert.ok(await details.getByRole("heading", { name: "AuroraPelaa", exact: true }).isVisible());
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await details.getByRole("button", { name: "Copy map link", exact: true }).click();
      assert.match(await details.getByRole("status").innerText(), /Map link copied/);
      const shared = await page.evaluate(() => navigator.clipboard.readText());
      const copy = await context.newPage();
      await copy.goto(shared);
      await copy.waitForLoadState("networkidle");
      assert.ok(await copy.getByRole("region", { name: "Selected channel" }).getByRole("heading", { name: "AuroraPelaa", exact: true }).isVisible());
      await copy.close();
      const unchangedUrl = page.url();
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await page.locator(".community-canvas").focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(page.url(), unchangedUrl);
      await page.screenshot({ path: fileURLToPath(new URL(`${phase}-community-${width}.png`, evidence)) });
      await details.getByRole("button", { name: "Close channel details", exact: true }).click();
      assert.equal(new URL(page.url()).searchParams.has("channel"), false);
      await page.goBack();
      assert.ok(await details.isVisible());
      await page.keyboard.press("Escape");
      assert.equal(await details.count(), 0);
      for (const query of ["channel=missing", "channel=goal-aurora&channel=goal-sisu"]) {
        await page.goto(`http://127.0.0.1:3300/communities?${query}`);
        await page.waitForLoadState("networkidle");
        assert.match(await page.getByRole("status").innerText(), /linked channel is unavailable/);
        await page.getByRole("button", { name: "Fit map", exact: true }).click();
        assert.equal(new URL(page.url()).searchParams.has("channel"), false);
      }
      await page.getByRole("searchbox", { name: "Search channels" }).fill("Lumi");
      await page.getByRole("button", { name: /LumiStudio/ }).click();
      const unconnectedUrl = page.url();
      await page.reload();
      await page.waitForLoadState("networkidle");
      assert.ok(await details.getByRole("heading", { name: "LumiStudio", exact: true }).isVisible());
      assert.ok(await page.locator(`.community-node[data-channel="${new URL(unconnectedUrl).searchParams.get("channel")}"]`).isVisible());
      if (width === 1440) {
        await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("Synthetic denied clipboard"); } } }); });
        await details.getByRole("button", { name: "Copy map link", exact: true }).click();
        assert.equal(await details.getByLabel("Copy this map link", { exact: true }).inputValue(), page.url());
      }
      await page.getByRole("button", { name: "Fit map", exact: true }).click();
      assert.equal(new URL(page.url()).searchParams.has("channel"), false);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    checks.push({ width, selectedUrl, restored: phase !== "before", copyAndBack: phase !== "before", invalidAndUnconnected: phase !== "before", errors });
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(new URL(`${phase}-community-sharing.json`, evidence), JSON.stringify(checks, null, 2) + "\n");
}
console.log(JSON.stringify(checks, null, 2));
