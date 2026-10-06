import assert from "node:assert/strict";

// Pass the CUA tab after running freshness-fixture.mjs mixed. No separate browser runtime.
export async function checkMixedFreshness(tab) {
  const page = tab.playwright;
  await page.getByRole("heading", { name: "Live streams", exact: true }).waitFor({ state: "visible" });
  const summary = await page.getByRole("region", { name: "Live stream summary" }).innerText();
  assert.match(summary, /Recently live\s+3/);
  assert.match(summary, /Observed viewers\s+100/);
  assert.match(summary, /2 of 3/);
  const stale = page.getByRole("row").filter({ hasText: "@sisulive" });
  assert.match(await stale.innerText(), /Unconfirmed/);
  assert.match(await stale.innerText(), /200/);
  assert.match(await stale.innerText(), /old sample/);
  assert.match(await stale.innerText(), /Coverage unconfirmed/);
  const zero = page.getByRole("row").filter({ hasText: "@lumistudio" });
  assert.match(await zero.getByRole("cell").nth(4).innerText(), /^0\s/);
  assert.match(await page.getByRole("row").filter({ hasText: "@kettukahvi" }).innerText(), /—\s+No sample/);
  await page.getByRole("searchbox", { name: "Search live streams" }).fill("Sisu");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("heading", { name: "Search results" }).waitFor({ state: "visible" });
  const before = await tab.url();
  await page.getByRole("button", { name: "Refresh data", exact: true }).click();
  await page.getByRole("button", { name: "Refreshing…", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await tab.url(), before, "Refreshing retains the search and anchor");
  assert.equal(await page.getByRole("searchbox", { name: "Search live streams" }).getAttribute("value"), "Sisu");
  await page.getByRole("region", { name: "Live Finnish stream ranking" }).getByRole("link", { name: "SisuLive", exact: true }).click();
  await page.getByRole("heading", { name: "SisuLive", exact: true }).waitFor({ state: "visible" });
  assert.match(await page.locator(".channel-live").innerText(), /Unconfirmed/);
  await page.getByRole("link", { name: "Streams", exact: true }).click();
  await page.getByRole("heading", { name: "Stream history" }).waitFor({ state: "visible" });
  const session = page.locator(".channel-session-card").filter({ hasText: "Unconfirmed" });
  assert.match(await session.innerText(), /1h 0m observed/);
  await session.getByRole("link").click();
  await page.getByText("Live status is unconfirmed", { exact: true }).waitFor({ state: "visible" });
  assert.match(await page.locator(".stream-session-context").innerText(), /1h 0m observed/);
  const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(geometry.scrollWidth <= geometry.width, "No document overflow");
  return { summary, searchAndRefresh: true, channelHistoryAndStream: true, geometry };
}

export async function checkSummary(tab, { recent, viewers, samples }) {
  await tab.playwright.getByRole("heading", { name: "Live streams", exact: true }).waitFor({ state: "visible" });
  const text = await tab.playwright.getByRole("region", { name: "Live stream summary" }).innerText();
  assert.match(text, new RegExp(`Recently live\\s+${recent}\\b`));
  assert.match(text, new RegExp(`Observed viewers\\s+${viewers}`));
  if (samples != null) assert.ok(text.includes(samples));
  return text;
}
