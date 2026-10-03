import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
const directory = new URL("./evidence/", import.meta.url);
await mkdir(directory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    // No external images or integrations are required for synthetic QA.
    await page.route(/^https?:\/\/(?!127\.0\.0\.1(?=[:/]))/, route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>' }));
    for (const [name, path] of [["live","/"],["channel","/channels/aurorapelaa"],["stream","/streams/goal-aurora-0"],["chat","/streams/goal-aurora-0/chat"],["communities","/communities"],["account","/me"]]) {
      const response = await page.goto(`http://127.0.0.1:3300${path}`);
      await page.locator("main").waitFor();
      await page.waitForFunction(() => !document.querySelector("main")?.textContent?.includes("Loading analytics"));
      await page.waitForLoadState("networkidle");
      await page.screenshot({ path: new URL(`before-${name}-${viewport.width}.png`,directory).pathname.slice(1), fullPage: true, caret: "initial" });
      report.push({ name, width: viewport.width, status: response.status(), overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), text: (await page.locator("main").innerText()).slice(0,2200) });
    }
    report.push({ width: viewport.width, errors });
    await page.close();
  }
} finally { await browser.close(); }
await writeFile(new URL("baseline-browser.json",directory),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
