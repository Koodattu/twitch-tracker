import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
const evidence = new URL("./evidence/", import.meta.url);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.route(/^https?:\/\/(?!127\.0\.0\.1(?=[:/]))/, route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>' }));
    const ready = async () => {
      await page.waitForFunction(() => !document.querySelector("main")?.textContent?.includes("Loading analytics"));
      await page.waitForLoadState("networkidle");
    };
    const capture = async name => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false,`${name}: page overflow at ${width}px`);
      await page.screenshot({ path: fileURLToPath(new URL(`after-${name}-${width}.png`,evidence)), fullPage: true, caret: "initial" });
    };
    await page.goto("http://127.0.0.1:3300/");
    await ready();
    const search = page.getByRole("searchbox", { name: "Search live streams" });
    await search.fill("  LUMISTUDIO  ");
    await search.press("Enter");
    await page.waitForURL(/q=/);
    await ready();
    assert.equal(await search.inputValue(),"LUMISTUDIO");
    assert.equal(await page.locator(".live-ranking-table tbody tr").count(),1);
    assert.equal((await page.locator(".rank-cell").innerText()).trim(),"4");
    await capture("live-search");
    await page.getByRole("link",{name:"LumiStudio",exact:true}).first().click();
    await page.waitForURL(/channels\/lumistudio/);
    await ready();
    assert.ok((await page.locator("main").innerText()).includes("Hours streamed"));
    await page.goBack();
    await ready();
    assert.equal(await search.inputValue(),"LUMISTUDIO");
    await search.fill("no-such-live-channel");
    await search.press("Enter");
    await page.waitForURL(/no-such-live-channel/);
    await ready();
    assert.ok(await page.getByRole("heading",{name:"No matching live streams"}).isVisible());
    await capture("live-empty-search");
    await page.getByRole("link",{name:"Clear search",exact:true}).first().click();
    await page.waitForURL(url => url.search === "");
    await page.getByRole("heading",{name:"Full live ranking",exact:true}).waitFor();
    await ready();
    assert.equal(await search.inputValue(),"");
    assert.equal(await page.locator(".live-ranking-table tbody tr").count(),4);
    await capture("live");
    results.push({width,journeys:["search with keyboard","case-insensitive channel match","global ranking preserved","channel navigation and browser back preserve query","no matches and clear"],errors});
    assert.deepEqual(errors,[]);
    await page.close();
  }
} finally { await browser.close(); }
await writeFile(new URL("browser-journeys.json",evidence),JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
