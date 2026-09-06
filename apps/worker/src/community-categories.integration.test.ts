import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type CommunityBuildClaim } from "@twitch-tracker/db";
import type { CommunityGraph } from "@twitch-tracker/shared";
import { addCommunityCategories } from "./community-categories.js";

const url = process.env.TEST_DATABASE_URL;
if (url != null && !new URL(url).pathname.toLowerCase().includes("test")) throw new Error("TEST_DATABASE_URL must name a dedicated test database.");
const database = url == null ? null : createDb(url);
const claim: CommunityBuildClaim = { owner: "test", requestVersion: 0, privacyVersion: 0, previous: null,
  windowStart: new Date("2026-08-11T00:00:00Z"), windowEnd: new Date("2026-08-12T00:00:00Z") };
const graph = (): CommunityGraph => ({nodes:[{id:"channel",chatters:10,x:0,y:0,community:"group"}],edges:[]});

describe.skipIf(database == null)("Historical community categories", () => {
  if (database == null) return;
  const { db, pool } = database;
  beforeEach(async () => {
    await pool.query("truncate table twitch_users cascade");
    await pool.query(`insert into twitch_users (twitch_user_id) values ('channel');
      insert into stream_sessions (twitch_stream_id,broadcaster_user_id,started_at,first_seen_at,last_seen_live_at,ended_at,is_finnish_eligible,initial_category_id,initial_category_name)
      values ('stream','channel','2026-08-10 22:00Z','2026-08-10 22:00Z','2026-08-11 04:00Z','2026-08-11 04:00Z',true,'wow','World of Warcraft')`);
  });
  afterAll(async () => { await pool.end(); });

  it("uses category duration within the reporting window and carries categories across compact snapshots", async () => {
    await pool.query(`insert into stream_snapshots (twitch_stream_id,broadcaster_user_id,observed_at,category_id,category_name) values
      ('stream','channel','2026-08-11 01:00Z',null,null),
      ('stream','channel','2026-08-11 03:00Z','music','Music'),
      ('stream','channel','2026-08-11 03:01Z','music','Music'),
      ('stream','channel','2026-08-11 03:02Z','music','Music'),
      ('stream','channel','2026-08-13 03:00Z','chess','Chess')`);
    const value = graph(); await addCommunityCategories(db,claim,value);
    expect(value.nodes[0]!.category).toEqual({id:"wow",name:"World of Warcraft",share:0.75});
  });

  it("uses the last category observed before the window, without using a stream's eventual latest category", async () => {
    await pool.query(`update stream_sessions set latest_category_id = 'chess',latest_category_name = 'Chess';
      insert into stream_snapshots (twitch_stream_id,broadcaster_user_id,observed_at,category_id,category_name)
      values ('stream','channel','2026-08-10 23:00Z','music','Music')`);
    const value = graph(); await addCommunityCategories(db,claim,value);
    expect(value.nodes[0]!.category).toEqual({id:"music",name:"Music",share:1});
  });

  it("omits categories when most observed stream time is unknown, including explicit category clearing", async () => {
    await pool.query(`insert into stream_snapshots (twitch_stream_id,broadcaster_user_id,observed_at,category_id,category_name)
      values ('stream','channel','2026-08-11 01:00Z','','')`);
    const value = graph(); await addCommunityCategories(db,claim,value);
    expect(value.nodes[0]!.category).toBeUndefined();
  });

  it("ignores non-Finnish sessions and does not fabricate category information", async () => {
    await pool.query("update stream_sessions set is_finnish_eligible = false");
    const value = graph(); await addCommunityCategories(db,claim,value);
    expect(value.nodes[0]!.category).toBeUndefined();
    await expect(addCommunityCategories(db,claim,{nodes:[],edges:[]})).resolves.toBeUndefined();
  });
});
