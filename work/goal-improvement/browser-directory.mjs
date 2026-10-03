// Uses only bounded synthetic fixtures and localhost services; never calls Twitch.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureUrl } from "./fixture.mjs";

const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const { Pool } = require("pg");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
const phase = process.argv[2] ?? "built";
assert.match(phase, /^(before|built)$/);
const evidence = new URL(process.env.GOAL_EVIDENCE_DIR ?? "./evidence/round3/", import.meta.url);
const failureFlag = new URL("../../.temp/goal-api-failure", import.meta.url);
await mkdir(evidence, { recursive: true });
const pool = new Pool({ connectionString: fixtureUrl });
const browser = await chromium.launch({ headless: true });
const ids = Array.from({ length: 52 }, (_, index) => `directory-qa-${String(index).padStart(2, "0")}`);
ids.push("directory-qa-talvi");
const results = [];
const fixtureStart = new Date(Date.now() - 40 * 86_400_000);
const fixtureEnd = new Date(fixtureStart.getTime() + 3_600_000);
try {
  for (const [index, id] of ids.entries()) {
    const login = index === 52 ? "talvistudio" : `archive${String(index).padStart(2, "0")}`;
    const display = index === 52 ? "Talvi Studio" : index === 0 ? "Archive With A Very Long Channel Display Name" : `Archive ${String(index).padStart(2, "0")}`;
    await pool.query("insert into twitch_users(twitch_user_id,login,display_name) values($1,$2,$3)", [id, login, display]);
    await pool.query(`insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,first_seen_at,last_seen_live_at,ended_at,is_finnish_eligible,finnish_match_reason,latest_title,latest_category_name)
      values($1,$2,$6,$6,$7,case when $3 then null else $7::timestamptz end,true,'language',$4,$5)`,
    [`${id}-stream`, id, index === 0, index === 52 ? "Winter drawing with friends" : "An archived Finnish broadcast", index % 2 === 0 ? "Art" : null, fixtureStart, fixtureEnd]);
  }
  for (const width of [1440, 768, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce", hasTouch: width < 500 });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("response", response => { if (response.url().startsWith("http://127.0.0.1:") && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
    await page.context().addCookies([{ name: "goal-qa", value: "synthetic", url: "http://127.0.0.1:3300" }]);
    await page.route(/^https?:\/\/(?!127\.0\.0\.1(?=[:/]))/, route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }));
    const go = async path => { await page.goto(`http://127.0.0.1:3300${path}`); await page.waitForLoadState("networkidle"); };
    const capture = async name => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: no overflow`);
      await page.screenshot({ path: fileURLToPath(new URL(`${phase}-directory-${name}-${width}.png`, evidence)) });
    };
    await go("/?q=Talvi");
    if (phase === "before") {
      const hasDirectory = await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: "Channels", exact: true }).count() > 0;
      assert.equal(hasDirectory, false, "The baseline has no channel discovery entry");
      assert.equal(await page.getByRole("link", { name: "Talvi Studio", exact: true }).count(), 0);
      await capture("live-search-gap");
      await go("/channels/talvistudio");
      assert.ok(await page.getByRole("heading", { name: "Talvi Studio", exact: true }).isVisible(), "History exists when its URL is known");
      results.push({ width, missingDirectory: true, offlineProfileExists: true });
      await page.close();
      continue;
    }
    await page.getByRole("link", { name: "Search all channels", exact: true }).click();
    await page.waitForURL(/\/channels\?q=Talvi/);
    await page.getByRole("heading", { name: "Channels", exact: true }).waitFor();
    const primary = page.getByRole("navigation", { name: "Primary navigation" });
    assert.ok(await primary.evaluate(element => element.scrollWidth <= element.clientWidth), "All public navigation items fit");
    assert.equal(await page.getByLabel("Search channels", { exact: true }).inputValue(), "Talvi");
    assert.equal(await page.locator(".channel-directory-row").count(), 1);
    assert.match(await page.locator(".channel-directory-row").innerText(), /Winter drawing/);
    await capture("offline-result");
    await page.getByRole("link", { name: /Talvi Studio.*talvistudio/ }).click();
    await page.getByRole("heading", { name: "Talvi Studio", exact: true }).waitFor();
    await page.getByRole("navigation", { name: "Channel pages" }).getByRole("link", { name: "Streams", exact: true }).click();
    await page.getByRole("heading", { name: "Stream history", exact: true }).waitFor();
    assert.match(await page.locator("main").innerText(), /Winter drawing/);
    await page.goBack(); await page.goBack();
    assert.equal(await page.getByLabel("Search channels", { exact: true }).inputValue(), "Talvi");
    await page.reload();
    assert.equal(await page.locator(".channel-directory-row").count(), 1);
    await page.locator(".channel-directory-broadcast a").click();
    await page.waitForURL(/\/streams\/directory-qa-talvi-stream$/);
    await page.getByRole("heading", { name: "Winter drawing with friends", exact: true }).waitFor();
    assert.ok(await page.getByRole("heading", { name: "Winter drawing with friends", exact: true }).isVisible());
    await page.goBack();
    await page.getByLabel("Search channels", { exact: true }).fill("Archive");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.waitForURL(/q=Archive/);
    await page.locator(".channel-directory-row").first().waitFor();
    assert.equal(await page.locator(".channel-directory-row").count(), 50);
    const firstNames = await page.locator(".channel-directory-identity strong").allTextContents();
    assert.equal(await page.getByText("Live now", { exact: true }).count(), 1);
    await capture("busy");
    await page.getByRole("link", { name: "Next page", exact: true }).click();
    await page.waitForURL(/page=2/);
    assert.equal(await page.getByLabel("Search channels", { exact: true }).inputValue(), "Archive");
    assert.equal(await page.locator(".channel-directory-row").count(), 2);
    const secondNames = await page.locator(".channel-directory-identity strong").allTextContents();
    assert.equal(new Set([...firstNames, ...secondNames]).size, 52);
    await page.getByRole("link", { name: "Previous page", exact: true }).click();
    await page.waitForURL(/page=1/);
    await page.getByRole("link", { name: "Clear search", exact: true }).click();
    await page.waitForURL("http://127.0.0.1:3300/channels");
    assert.equal(await page.getByLabel("Search channels", { exact: true }).inputValue(), "");
    await go("/channels?q=NoSuchChannel");
    assert.ok(await page.getByRole("heading", { name: "No matching channels", exact: true }).isVisible());
    await capture("empty");
    await go(`/channels?q=${"a".repeat(100)}`);
    await capture("long-query");
    await go("/channels?q=Archive&page=999");
    assert.ok(await page.getByRole("link", { name: "First page", exact: true }).isVisible());
    await page.getByRole("link", { name: "First page", exact: true }).click();
    await page.waitForURL(/q=Archive.*page=1/);
    await go("/channels?q=one&q=two&page=bad");
    assert.equal(await page.getByLabel("Search channels", { exact: true }).inputValue(), "");
    await writeFile(failureFlag, "/api/channels");
    await go("/channels?q=Talvi");
    assert.ok(await page.getByRole("heading", { name: "Channels are unavailable", exact: true }).isVisible());
    await capture("retry");
    await rm(failureFlag);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page.locator(".channel-directory-row").waitFor();
    assert.equal(await page.getByLabel("Search channels", { exact: true }).inputValue(), "Talvi");
    const identity = page.locator(".channel-directory-identity");
    assert.ok((await identity.boundingBox()).height >= 44);
    assert.ok((await page.locator(".channel-directory-broadcast a").boundingBox()).height >= 44);
    await page.keyboard.press("Tab");
    await identity.focus();
    assert.ok(await identity.evaluate(element => element.matches(":focus-visible")));
    await capture("focus");
    if (width === 1440) {
      await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
      await capture("zoom");
      await page.evaluate(() => { document.documentElement.style.zoom = ""; });
    }
    if (width < 500) await identity.tap();
    else await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Talvi Studio", exact: true }).waitFor();
    assert.deepEqual(errors, []);
    results.push({ width, offlineDiscovery: true, history: true, urlPersistence: true, pagination: 52, recovery: true, keyboardOrTouch: true, errors });
    await page.close();
  }
} finally {
  await browser.close();
  await rm(failureFlag, { force: true });
  await pool.query("delete from stream_sessions where broadcaster_user_id=any($1)", [ids]);
  await pool.query("delete from twitch_users where twitch_user_id=any($1)", [ids]);
  await pool.end();
}
await writeFile(new URL(`${phase}-directory.json`, evidence), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
