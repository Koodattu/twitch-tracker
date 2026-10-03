// Synthetic local session, as used by the API integration tests. No Twitch login.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encryptSecret, hashSessionToken } from "../../packages/config/dist/index.js";
import { fixtureUrl } from "./fixture.mjs";
const { Pool } = createRequire(new URL("../../packages/db/package.json", import.meta.url))("pg");
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
const phase = process.argv[2] ?? "after";
assert.match(phase, /^(before|after|built)$/);
const pool = new Pool({ connectionString: fixtureUrl });
const evidence = new URL("./evidence/round2/", import.meta.url);
const failureFlag = new URL("../../.temp/goal-api-failure", import.meta.url);
const secret = "synthetic-local-goal-test-session-secret-only";
const token = "round2-synthetic-account-session-only";
const results = [];
let ownedUserId;
let browser;
await mkdir(evidence, { recursive: true });
try {
  ownedUserId = (await pool.query("insert into app_users(twitch_user_id) values('goal-chat') returning id")).rows[0].id;
  await pool.query("insert into sessions(session_id_hash,app_user_id,expires_at) values($1,$2,now()+interval '1 hour')", [hashSessionToken(token, secret), ownedUserId]);
  await pool.query(`insert into oauth_accounts(app_user_id,provider_user_id,encrypted_access_token,last_validated_at,expires_at)
    values($1,'goal-chat',$2,now(),now()+interval '1 hour')`, [ownedUserId, encryptSecret("synthetic-not-a-twitch-token", secret)]);
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.context().addCookies([{ name: "twitch_tracker_session", value: token, url: "http://127.0.0.1:3300" }]);
    await page.route(/^https?:\/\/(?!127\.0\.0\.1(?=[:/]))/, route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }));
    const go = async path => {
      await page.goto(`http://127.0.0.1:3300${path}`);
      await page.waitForLoadState("networkidle");
    };
    const capture = async name => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: fileURLToPath(new URL(`${phase}-account-${name}-${width}.png`, evidence)) });
    };
    await go("/me");
    assert.ok(await page.getByRole("heading", { name: "Your activity", exact: true }).isVisible());
    assert.equal(await page.locator(".message-item").count(), 55);
    const recovery = [];
    for (const scenario of [
      { api: "/api/me", heading: "Account service unavailable", restored: "Your activity" },
      { api: "/api/me/data", heading: "Activity unavailable", restored: "Your recent messages" },
      { api: "/api/me/privacy", heading: "Privacy controls unavailable", restored: "No privacy requests" }
    ]) {
      await writeFile(failureFlag, scenario.api);
      await go("/me");
      const heading = page.getByRole("heading", { name: scenario.heading, exact: true });
      await heading.scrollIntoViewIfNeeded();
      assert.ok(await heading.isVisible());
      const retry = page.getByRole("button", { name: "Try again", exact: true }).first();
      const canRetry = await retry.count() === 1;
      await capture(scenario.api.split("/").at(-1));
      await rm(failureFlag);
      if (phase !== "before") {
        assert.ok(canRetry, `${scenario.heading} offers recovery`);
        await retry.click();
        await heading.waitFor({ state: "hidden" });
        await page.getByRole("heading", { name: scenario.restored, exact: true }).waitFor();
        assert.equal(await page.locator(".message-item").count(), 55);
      }
      recovery.push({ failure: scenario.api, canRetry });
    }
    // The API fails before the synthetic write; exercise the actual server action.
    await go("/me");
    await writeFile(failureFlag, "/api/me/privacy/requests");
    await page.getByRole("button", { name: "Hide public summary", exact: true }).click();
    await page.waitForURL(/privacy=failed/);
    await page.waitForLoadState("networkidle");
    await rm(failureFlag);
    const failureNotice = page.getByRole("alert").filter({ hasText: "Privacy request" });
    const failureCopy = await failureNotice.innerText();
    if (phase !== "before") assert.match(failureCopy, /could not be confirmed.*Check its status/s);
    await failureNotice.scrollIntoViewIfNeeded();
    await capture("submission-failed");
    assert.equal((await pool.query("select count(*)::int as n from privacy_requests where subject_twitch_user_id='goal-chat'")).rows[0].n, 0);
    assert.deepEqual(errors, []);
    results.push({ width, messages: 55, recovery, failureCopy, errors });
    await page.close();
  }
} finally {
  await rm(failureFlag, { force: true });
  await browser?.close();
  if (ownedUserId != null) {
    await pool.query("delete from sessions where app_user_id=$1", [ownedUserId]);
    await pool.query("delete from oauth_accounts where app_user_id=$1", [ownedUserId]);
    await pool.query("delete from app_users where id=$1", [ownedUserId]);
  }
  await pool.end();
  await writeFile(new URL(`${phase}-account.json`, evidence), JSON.stringify(results, null, 2) + "\n");
}
console.log(JSON.stringify(results, null, 2));
