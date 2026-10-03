import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureUrl } from "./fixture.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));
const { Pool } = createRequire(new URL("../../packages/db/package.json",import.meta.url))("pg");
const pool = new Pool({connectionString: fixtureUrl});
const evidence = new URL(process.env.GOAL_EVIDENCE_DIR ?? "./evidence/", import.meta.url);
await mkdir(evidence, { recursive: true });
const failureFlag = new URL("../../.temp/goal-api-failure",import.meta.url);
await mkdir(new URL("../../.temp/",import.meta.url), { recursive: true });
const browser = await chromium.launch({headless:true});
const results=[];
let originalMap;
try {
  originalMap=(await pool.query("select id,graph from community_map_snapshots where recipe='synthetic-goal-qa'")).rows[0];
  await pool.query("insert into twitch_users(twitch_user_id,login,display_name) select 'goal-directory-'||i,'fixturechannel'||i,'FixtureChannel'||i from generate_series(1,101) i on conflict do nothing");
  await pool.query(`insert into stream_sessions(twitch_stream_id,broadcaster_user_id,started_at,language,is_finnish_eligible,latest_title)
    select 'goal-directory-'||i,'goal-directory-'||i,now(),'fi',true,'Pagination fixture' from generate_series(1,101) i on conflict do nothing`);
  for (const width of [1440,390]) {
    const page=await browser.newPage({viewport:{width,height:900},reducedMotion:"reduce"});
    page.setDefaultTimeout(15000);
    const errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.context().addCookies([{name:"goal-qa",value:"synthetic",url:"http://127.0.0.1:3300"}]);
    await page.route(/^https?:\/\/(?!127\.0\.0\.1(?=[:/]))/,route=>route.fulfill({status:200,contentType:"image/svg+xml",body:'<svg xmlns="http://www.w3.org/2000/svg"/>'}));
    const ready=async()=>{
      await page.waitForFunction(()=>!document.querySelector("main")?.textContent?.includes("Loading analytics"));
      await page.waitForLoadState("networkidle");
    };
    const go=async path=>{await page.goto(`http://127.0.0.1:3300${path}`);await ready();};
    const capture=async name=>{
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:fileURLToPath(new URL(`after-${name}-${width}.png`,evidence)),fullPage:true,caret:"initial"});
    };
    await go("/?q=fixture");
    assert.equal(await page.locator(".live-ranking-table tbody tr").count(),100);
    await page.getByRole("link",{name:"Next",exact:true}).click();
    await page.waitForURL(/page=2/);await ready();
    assert.equal(new URL(page.url()).searchParams.get("q"),"fixture");
    assert.equal(await page.locator(".live-ranking-table tbody tr").count(),1);
    assert.equal(await page.locator(".rank-cell").innerText(),"105");
    await capture("pagination");
    await go("/?q=northern");
    assert.equal(await page.locator(".live-ranking-table tbody tr").count(),1);
    await go("/?q=Art");
    assert.equal(await page.locator(".live-ranking-table tbody tr").count(),1);
    await go("/?q=a&q=b&page=999999999");
    assert.ok(await page.getByRole("heading",{name:"Full live ranking",exact:true}).isVisible());

    await writeFile(failureFlag,"/api/streams/live");
    await go("/?q=aurora");
    assert.ok(await page.getByRole("heading",{name:"Live data is unavailable"}).isVisible());
    assert.equal(await page.getByRole("searchbox").inputValue(),"aurora");
    await capture("live-unavailable");
    await rm(failureFlag);
    await page.getByRole("button",{name:"Try again",exact:true}).click();
    await page.locator(".live-ranking-table tbody tr").first().waitFor();await ready();
    assert.equal(await page.getByRole("searchbox").inputValue(),"aurora");
    assert.equal(await page.locator(".live-ranking-table tbody tr").count(),1);

    await go("/channels/aurorapelaa");
    assert.ok((await page.locator(".channel-category-summary").innerText()).includes("3h 0m classified"));
    await page.getByRole("button",{name:"Messages",exact:true}).click();
    assert.ok(await page.getByRole("heading",{name:"Chat over time"}).isVisible());
    await page.getByRole("slider",{name:"Inspect a day (UTC)"}).focus();
    await page.keyboard.press("ArrowLeft");
    await capture("channel-messages");
    for (const path of ["/channels/aurorapelaa/streams","/channels/aurorapelaa/data?view=observations","/streams/goal-aurora-0/events","/streams/goal-aurora-0/data"]) {
      await go(path);
      assert.ok(!(await page.locator("main").innerText()).includes("Details unavailable"));
    }
    await go("/streams/goal-aurora-0/chat?chatter=TESTICHAT");
    assert.equal(await page.locator(".message-item").count(),50);
    await page.getByRole("link",{name:"Load older",exact:true}).click();
    await page.waitForURL(/page=2/);await ready();
    assert.equal(await page.locator(".message-item").count(),5);
    assert.equal(new URL(page.url()).searchParams.get("chatter"),"TESTICHAT");
    await capture("chat-older");
    await go("/streams/goal-aurora-0/chat?chatter=testichat&from=2026-10-03T12:00&to=2026-10-03T10:00");
    assert.ok(await page.getByRole("heading",{name:"Check the time range"}).isVisible());
    assert.equal(await page.getByLabel("Chatter login").inputValue(),"testichat");
    await writeFile(failureFlag,"/api/private/streams/goal-aurora-0/messages");
    await go("/streams/goal-aurora-0/chat?chatter=testichat");
    assert.ok(await page.getByRole("heading",{name:"Details unavailable"}).isVisible());
    await rm(failureFlag);
    await page.getByRole("button",{name:"Try again",exact:true}).click();
    await page.locator(".message-item").first().waitFor();
    assert.equal(await page.getByLabel("Chatter login").inputValue(),"testichat");

    await go("/communities");
    await page.getByRole("searchbox",{name:"Search channels"}).fill("Aurora");
    await page.locator(".community-channel-list button").first().press("Enter");
    assert.ok(await page.getByRole("region",{name:"Selected channel"}).isVisible());
    await capture("community-selected");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("region",{name:"Selected channel"}).count(),0);
    await page.getByRole("button",{name:"Zoom in",exact:true}).click();
    await page.getByRole("button",{name:"Fit map",exact:true}).click();
    await page.getByRole("button",{name:/How it works/}).click();
    assert.ok(await page.locator("#community-explanation").isVisible());
    await page.keyboard.press("Escape");
    await page.locator(".community-canvas").press("ArrowRight");
    await capture("community-keyboard");
    results.push({width,verified:["101 filtered results with preserved query/ranks","title/category search","duplicate query handling","outage/retry with input preserved","channel chart and history/data","chat paging/filter validation/retry","community selection/escape/zoom/help/keyboard"],errors});
    assert.deepEqual(errors,[]);
    await page.close();
  }
} finally {
  await rm(failureFlag,{force:true});
  if(originalMap)await pool.query("update community_map_snapshots set graph=$2 where id=$1",[originalMap.id,originalMap.graph]);
  await pool.query("delete from stream_sessions where twitch_stream_id like 'goal-directory-%'");
  await pool.query("delete from twitch_users where twitch_user_id like 'goal-directory-%'");
  await pool.end();
  await browser.close();
}
await writeFile(new URL("browser-extended.json",evidence),JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
