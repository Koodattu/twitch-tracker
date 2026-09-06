import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@twitch-tracker/db";
import { loadConfig } from "@twitch-tracker/config";
import { DisabledHelixAdapter, parseIrcLine, type HelixUser } from "@twitch-tracker/twitch";
import { findMembershipIdentity, resolveMembershipIdentities } from "./membership-identity.js";
import { persistMembershipEvent } from "./irc.js";

vi.mock("../bot-auth.js", () => ({ resolvePrimaryBotCredentials: async () => ({ accessToken: "synthetic-test-token" }) }));
const url = process.env.TEST_DATABASE_URL;
if (url != null && !new URL(url).pathname.toLowerCase().includes("test")) throw new Error("TEST_DATABASE_URL must name a dedicated test database.");
const database = url == null ? null : createDb(url);
const user = (id: string, login = id): HelixUser => ({ id, login, display_name: login, type: "", broadcaster_type: "",
  description: "", profile_image_url: "", offline_image_url: "", created_at: "2020-01-01T00:00:00Z" });

describe.skipIf(database == null)("Membership identity with PostgreSQL", () => {
  if (database == null) return;
  const { db, pool } = database;
  const rest = new DisabledHelixAdapter();
  const getUsers = vi.spyOn(rest, "getUsers");
  const context = { db, rest, config: loadConfig({ DATABASE_URL: url, SESSION_SECRET: "s".repeat(48), ENABLE_TWITCH_INGESTION: "true", TWITCH_CLIENT_ID: "test" }),
    workerName: "test", abortSignal: new AbortController().signal };
  const response = (users: HelixUser[], statusCode = 200) => getUsers.mockResolvedValue({ endpoint: "/users", requestParams: {},
    statusCode, responseJson: { data: users }, pagination: {}, rateLimit: { limit: null, remaining: null, resetAt: null, raw: {} }, observedAt: new Date() });
  beforeEach(async () => {
    getUsers.mockReset();
    await pool.query("truncate table twitch_users, community_map_state cascade");
    await pool.query(`insert into community_map_state (id) values ('current');
      insert into twitch_users (twitch_user_id, login, last_metadata_refresh_at) values ('channel','channel',now()),('known','known',now()),('stale','stale',now() - interval '2 days');
      insert into stream_sessions (twitch_stream_id, broadcaster_user_id, started_at, is_finnish_eligible) values ('stream','channel',now() - interval '4 hours',true)`);
  });
  afterAll(async () => { await pool.end(); });
  const event = async (login: string, age = "1 hour") => pool.query(`insert into chat_membership_events
    (broadcaster_user_id, twitch_stream_id, chatter_login, event_type, received_at) values ('channel','stream',$1,'join',now() - $2::interval)`, [login, age]);

  it("writes verified IDs for JOIN and PART while leaving stale or ambiguous identities unresolved", async () => {
    for (const command of ["JOIN","PART"]) for (const login of ["known","stale"]) {
      await persistMembershipEvent(db, "00000000-0000-0000-0000-000000000001", parseIrcLine(`:${login}!${login}@${login}.tmi.twitch.tv ${command} #channel`), null, "channel");
    }
    const rows = (await pool.query("select chatter_login, chatter_user_id from chat_membership_events order by chatter_login")).rows;
    expect(rows.filter((row) => row.chatter_login === "known").every((row) => row.chatter_user_id === "known")).toBe(true);
    expect(rows.filter((row) => row.chatter_login === "stale").every((row) => row.chatter_user_id == null)).toBe(true);
    await pool.query("insert into twitch_users (twitch_user_id,login,last_metadata_refresh_at) values ('duplicate','known',now())");
    expect(await findMembershipIdentity(db,"known",new Date())).toBeNull();
    expect(getUsers).not.toHaveBeenCalled();
  });

  it("resolves recent lurkers in one batch, preserves unknown names, and never maps old events to current login owners", async () => {
    await event("lurker"); await event("lurker","2 hours"); await event("unknown"); await event("lurker","2 days");
    response([user("lurker-id","lurker")]);
    expect(await resolveMembershipIdentities(context)).toEqual({ checkedLogins: 2, resolvedEvents: 2 });
    expect(getUsers).toHaveBeenCalledTimes(1);
    expect((await pool.query("select count(*)::int as n from chat_membership_events where chatter_user_id = 'lurker-id'")).rows[0].n).toBe(2);
    expect((await pool.query("select chatter_user_id,identity_checked_at from chat_membership_events where received_at < now() - interval '1 day'")).rows[0]).toEqual({ chatter_user_id: null, identity_checked_at: null });
    expect(await findMembershipIdentity(db,"lurker",new Date())).toBe("lurker-id");
    expect(await resolveMembershipIdentities(context)).toEqual({ checkedLogins: 0, resolvedEvents: 0 });
  });

  it("leaves work pending on rate limits and retries successfully", async () => {
    await event("lurker"); response([],429);
    await expect(resolveMembershipIdentities(context)).rejects.toThrow("429");
    expect((await pool.query("select identity_checked_at from chat_membership_events")).rows[0].identity_checked_at).toBeNull();
    response([user("lurker")]);
    expect((await resolveMembershipIdentities(context)).resolvedEvents).toBe(1);
  });

  it("does not reattach deleted identities, resolve redacted events, or ingest opted-out members", async () => {
    await event("known"); await event("redacted");
    await pool.query(`insert into subject_privacy_states (twitch_user_id, tracking_opted_out, data_deleted_at) values ('known',true,now());
      update chat_membership_events set chatter_login = null where chatter_login = 'redacted'`);
    response([user("known")]);
    expect((await resolveMembershipIdentities(context)).resolvedEvents).toBe(0);
    await persistMembershipEvent(db,"00000000-0000-0000-0000-000000000001",parseIrcLine(":known!known@known.tmi.twitch.tv JOIN #channel"),null,"channel");
    expect((await pool.query("select count(*)::int as n from chat_membership_events")).rows[0].n).toBe(2);
    expect((await pool.query("select count(chatter_user_id)::int as n from chat_membership_events")).rows[0].n).toBe(0);
  });
});
