import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureUrl } from "./fixture.mjs";
const { Pool } = createRequire(new URL("../../packages/db/package.json", import.meta.url))("pg");
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
const pool = new Pool({ connectionString: fixtureUrl });
const evidence = new URL(process.env.GOAL_EVIDENCE_DIR ?? "./evidence/round2/", import.meta.url);
const phase = process.argv[2] ?? "built";
assert.match(phase, /^(before|after|built)$/);
const streamId = `goal-round2-chart-${Date.now()}`;
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  await pool.query(`insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,ended_at,last_seen_live_at,latest_title)
    values($1,'goal-aurora','2026-10-01T10:00:00Z','2026-10-01T20:00:00Z','2026-10-01T20:00:00Z','Synthetic chart boundary states')`, [streamId]);
  for (const width of [1440, 768, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce", hasTouch: width < 500 });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.context().addCookies([{ name: "goal-qa", value: "synthetic", url: "http://127.0.0.1:3300" }]);
    const go = async () => {
      await page.goto(`http://127.0.0.1:3300/streams/${streamId}`);
      await page.waitForLoadState("networkidle");
    };
    await pool.query("delete from stream_activity_buckets where twitch_stream_id=$1", [streamId]);
    await go();
    assert.ok(await page.getByRole("heading", { name: "No activity yet", exact: true }).isVisible());
    assert.equal(await page.getByRole("slider").count(), 0);
    await pool.query(`insert into stream_activity_buckets(twitch_stream_id,bucket_start,bucket_minutes,viewer_count_avg,viewer_count_max,message_count,active_chatter_count)
      values($1,'2026-10-01T10:00:00Z',1,0,0,0,0)`, [streamId]);
    await go();
    const inspector = page.getByRole("group", { name: "Inspect stream activity", exact: true });
    assert.equal(await page.locator('input[type="range"]').count(), 0);
    await inspector.focus();
    await page.keyboard.press("Home");
    await page.keyboard.press("End");
    const singleValues = await page.locator(".stream-chart-values").innerText();
    const result = { width, singleValues };
    checks.push(result);
    await page.locator(".chart-wrap").scrollIntoViewIfNeeded();
    await page.screenshot({ path: fileURLToPath(new URL(`${phase}-single-chart-${width}.png`, evidence)) });
    if (phase !== "before") assert.match(singleValues, /0 average \/ 0 peak viewers/, "Keyboard users can read the only interval, including observed zeros");
    await pool.query(`insert into stream_activity_buckets(twitch_stream_id,bucket_start,bucket_minutes,viewer_count_avg,viewer_count_max,message_count,active_chatter_count)
      select $1,timestamptz '2026-10-01T10:00:00Z'+make_interval(mins=>i),1,1000+i,1200+i,20+i,5+i
      from generate_series(1,600) i where i not between 230 and 240`, [streamId]);
    await go();
    const chart = page.getByRole("img", { name: /Stream activity/ });
    await chart.scrollIntoViewIfNeeded();
    const labelsFit = await chart.evaluate(svg => {
      const bounds = svg.getBoundingClientRect();
      return [...svg.querySelectorAll(".chart-axis-labels text")].every(label => {
        const rect = label.getBoundingClientRect();
        return rect.left >= bounds.left && rect.right <= bounds.right;
      });
    });
    assert.ok(labelsFit, "Chart labels fit within the viewport");
    for (const label of ["Viewers (average / peak)", "Messages / min", "Peak active chatters"]) {
      const toggle = page.getByRole("button", { name: label, exact: true });
      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-pressed"), "false");
      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-pressed"), "true");
    }
    if (width < 500) await inspector.tap();
    await inspector.focus();
    await page.keyboard.press("End");
    assert.match(await page.locator(".stream-chart-values").innerText(), /1,600 average \/ 1,800 peak viewers/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: fileURLToPath(new URL(`${phase}-dense-chart-${width}.png`, evidence)) });
    await page.setViewportSize({ width: width === 1440 ? 390 : 1440, height: 900 });
    await page.waitForFunction(() => {
      const svg = document.querySelector(".line-chart");
      return Math.abs(svg.getBoundingClientRect().width - svg.viewBox.baseVal.width) < 1;
    });
    if (width === 1440) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => { document.body.style.zoom = "2"; });
      await page.waitForFunction(() => {
        const svg = document.querySelector(".line-chart");
        return Math.abs(svg.getBoundingClientRect().width / 2 - svg.viewBox.baseVal.width) < 1;
      });
      await chart.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "200% CSS zoom has no document overflow");
      result.zoomedLabelPx = await chart.evaluate(svg => {
        const label = svg.querySelector(".chart-axis-labels text");
        return parseFloat(getComputedStyle(label).fontSize) * label.getScreenCTM().a;
      });
      assert.ok(result.zoomedLabelPx >= 22);
      await page.screenshot({ path: fileURLToPath(new URL(`${phase}-chart-zoom-1440.png`, evidence)) });
    }
    result.emptyState = true;
    result.denseChartWithGap = true;
    result.legendAndResize = true;
    result.touch = width < 500;
    assert.deepEqual(errors, []);
    await page.close();
  }
} finally {
  await browser.close();
  await pool.query("delete from stream_activity_buckets where twitch_stream_id=$1", [streamId]);
  await pool.query("delete from stream_sessions where twitch_stream_id=$1", [streamId]);
  await pool.end();
  await writeFile(new URL(`${phase}-chart-states.json`, evidence), JSON.stringify(checks, null, 2) + "\n");
}
console.log(JSON.stringify(checks, null, 2));
