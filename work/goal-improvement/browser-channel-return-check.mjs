import assert from "node:assert/strict";

// Start on a populated synthetic channel history with selected period/day/measure/page.
export async function checkChannelReturn(tab, input) {
  const page = tab.playwright;
  const click = (locator) => input == null ? locator.click() : input.click(locator);
  const press = (locator, key) => input == null ? locator.press(key) : input.press(locator, key);
  await page.getByRole("heading", { name: "Stream history" }).waitFor({ state: "visible" });
  const start = new URL(await tab.url());
  const entry = page.locator(".channel-session-card").first().getByRole("link");
  const streamUrl = new URL(await entry.getAttribute("href"), start.origin);
  assert.equal(streamUrl.searchParams.get("returnTo"), `${start.pathname}${start.search}`);
  await click(entry);
  await page.getByRole("group", { name: "Inspect stream activity", exact: true }).waitFor({ state: "visible" });
  const back = page.getByRole("link", { name: "Back to stream history", exact: true });
  assert.equal(await back.getAttribute("href"), `${start.pathname}${start.search}`);
  await press(page.getByRole("group", { name: "Inspect stream activity", exact: true }), "End");
  const selected = new URL(await tab.url());
  assert.ok(selected.searchParams.has("at"));
  assert.equal(selected.searchParams.get("returnTo"), streamUrl.searchParams.get("returnTo"));
  await click(page.getByRole("link", { name: "Events in this interval", exact: true }));
  await page.getByRole("heading", { name: "Channel events" }).waitFor({ state: "visible" });
  assert.equal(await back.getAttribute("href"), `${start.pathname}${start.search}`);
  await click(page.getByRole("button", { name: "Filter events", exact: true }));
  await page.getByRole("heading", { name: "Channel events" }).waitFor({ state: "visible" });
  assert.equal(new URL(await tab.url()).searchParams.get("returnTo"), streamUrl.searchParams.get("returnTo"));
  await click(page.getByRole("link", { name: "All events", exact: true }));
  await click(page.getByRole("navigation", { name: "Stream pages" }).getByRole("link", { name: "Data", exact: true }));
  await page.getByRole("heading", { name: "Viewer observations" }).waitFor({ state: "visible" });
  await click(page.getByRole("link", { name: "Activity detail", exact: true }));
  await page.getByRole("heading", { name: "Activity detail" }).waitFor({ state: "visible" });
  await tab.reload();
  await page.getByRole("heading", { name: "Activity detail" }).waitFor({ state: "visible" });
  assert.equal(await back.getAttribute("href"), `${start.pathname}${start.search}`);
  await click(back);
  await page.getByRole("heading", { name: "Stream history" }).waitFor({ state: "visible" });
  assert.equal(await tab.url(), start.href);
  const geometry = await page.evaluate(() => ({
    width: innerWidth, scroll: document.documentElement.scrollWidth,
    navWidth: document.querySelector('[aria-label="Primary navigation"]').clientWidth,
    navScroll: document.querySelector('[aria-label="Primary navigation"]').scrollWidth
  }));
  assert.ok(geometry.scroll <= geometry.width);
  assert.ok(geometry.navScroll <= geometry.navWidth, "Public navigation fits without sideways scrolling");
  return { start: start.pathname + start.search, selection: selected.searchParams.get("at"), returned: true, geometry };
}
