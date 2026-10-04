import assert from "node:assert/strict";

// Run through CUA's tab.playwright after seeding community-controls-fixture.mjs.
export async function checkSmallCommunity(page) {
  await page.getByRole("button", { name: "Browse channels", exact: true }).click();
  await page.getByLabel("Community", { exact: true }).selectOption("small-pair");
  const state = await page.evaluate(() => ({
    selectedGroup: document.querySelector("#community-filter")?.value,
    members: [...document.querySelectorAll('.community-node[data-channel^="pair-"]')].map(node => node.getAttribute("data-channel")),
    labels: [...document.querySelectorAll(".community-node-label")].map(node => node.textContent),
    view: document.querySelector(".community-canvas")?.getAttribute("viewBox")
  }));
  assert.equal(state.selectedGroup, "small-pair");
  assert.equal(state.members.join(","), "pair-0,pair-1", "Choosing a small community reveals both channels despite the overview filter");
  assert.equal(state.labels.sort().join(","), "SmallPair0,SmallPair1");
  assert.equal(state.view, "800 650 300 300", "The camera focuses the chosen community");
  return state;
}

export async function checkVisibilityJourney(page) {
  const initial = await checkSmallCommunity(page);
  await page.getByRole("button", { name: "SmallPair0 12", exact: true }).click();
  const selected = await page.evaluate(() => ({
    heading: document.querySelector(".community-details h2")?.textContent,
    members: document.querySelectorAll('.community-node[data-channel^="pair-"]').length,
    connections: document.querySelectorAll('[data-community-connections] line[stroke-opacity="0.75"]').length
  }));
  assert.equal(selected.heading, "SmallPair0");
  assert.equal(selected.members, 2, "Selecting one channel keeps its sparse neighbor visible");
  assert.equal(selected.connections, 1);
  const fromSelection = await checkSmallCommunity(page);
  await page.getByRole("button", { name: "Fit map", exact: true }).click();
  assert.equal(await page.locator(".community-node").count(), 72);
  await page.getByRole("searchbox", { name: "Search channels", exact: true }).fill("SmallPair");
  assert.equal(await page.locator('.community-node[data-channel^="pair-"]').count(), 2, "Search reveals matching sparse channels before selection");
  await page.getByRole("searchbox", { name: "Search channels", exact: true }).fill("");
  assert.equal(await page.locator(".community-node").count(), 72, "Clearing a search restores overview filtering");
  await page.getByLabel("Community", { exact: true }).selectOption("ungrouped");
  assert.equal(await page.locator(".community-node").count(), 78);
  await page.getByLabel("Community", { exact: true }).selectOption("all");
  assert.equal(await page.locator(".community-node").count(), 72, "Browsing unconnected channels does not change overview defaults");
  await page.getByRole("button", { name: "Fit map", exact: true }).click();
  return { initial, selected, fromSelection, searchAndReset: true, unconnectedAndReset: true };
}
