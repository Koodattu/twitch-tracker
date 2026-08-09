import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  botAccounts,
  channels,
  chatAssignmentEvents,
  chatAssignments,
  createChatAssignmentControl,
  createDb,
  streamSessions,
  subjectPrivacyStates,
  twitchUsers
} from "./index.js";
import { eq } from "drizzle-orm";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl != null && !new URL(testDatabaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("TEST_DATABASE_URL must name a dedicated test database.");
}
const database = testDatabaseUrl == null ? null : createDb(testDatabaseUrl);

describe.skipIf(database == null)("Chat Assignment control with PostgreSQL", () => {
  if (database == null) {
    return;
  }

  const { db, pool } = database;
  const assignments = createChatAssignmentControl(db);
  const observedAt = new Date("2026-08-09T12:00:00.000Z");

  beforeEach(async () => {
    await pool.query(`
      truncate table
        chat_assignment_events,
        chat_assignments,
        stream_snapshots,
        stream_sessions,
        subject_privacy_states,
        channels,
        bot_account_tokens,
        bot_accounts,
        twitch_users
      restart identity cascade
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  const createFixture = async (status: typeof chatAssignments.$inferInsert.status = "desired") => {
    await db.insert(twitchUsers).values({
      twitchUserId: "broadcaster-1",
      login: "channel",
      displayName: "Channel",
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      updatedAt: observedAt
    });
    await db.insert(channels).values({
      twitchUserId: "broadcaster-1",
      hasBeenSeenFinnish: true,
      firstSeenFinnishAt: observedAt,
      lastSeenFinnishAt: observedAt,
      updatedAt: observedAt
    });
    await db.insert(streamSessions).values({
      twitchStreamId: "stream-1",
      broadcasterUserId: "broadcaster-1",
      startedAt: observedAt,
      firstSeenAt: observedAt,
      lastSeenLiveAt: observedAt,
      language: "fi",
      updatedAt: observedAt
    });
    const [bot] = await db.insert(botAccounts).values({
      login: "bot",
      enabled: true,
      updatedAt: observedAt
    }).returning({ id: botAccounts.id });
    if (bot == null) {
      throw new Error("Failed to create test bot account.");
    }
    const [assignment] = await db.insert(chatAssignments).values({
      botAccountId: bot.id,
      broadcasterUserId: "broadcaster-1",
      twitchStreamId: "stream-1",
      status,
      reason: "test",
      joinedAt: status === "joined" || status === "leaving" ? observedAt : null,
      leftAt: status === "left" ? observedAt : null,
      updatedAt: observedAt
    }).returning({ id: chatAssignments.id });
    if (assignment == null) {
      throw new Error("Failed to create test Chat Assignment.");
    }
    return { assignmentId: assignment.id, botAccountId: bot.id };
  };

  it("records a transition and its event together", async () => {
    const fixture = await createFixture("desired");

    await assignments.record({
      type: "room_observed",
      botAccountId: fixture.botAccountId,
      broadcasterUserId: "broadcaster-1",
      observedAt
    });

    const [assignment] = await db.select().from(chatAssignments).where(eq(chatAssignments.id, fixture.assignmentId));
    const events = await db.select().from(chatAssignmentEvents).where(eq(chatAssignmentEvents.chatAssignmentId, fixture.assignmentId));
    expect(assignment?.status).toBe("joined");
    expect(events.map((event) => event.eventType)).toEqual(["joined"]);
    expect(events[0]?.details).toMatchObject({ previousStatus: "desired", source: "irc" });
  });

  it("does not reopen a terminal assignment after privacy closure", async () => {
    const fixture = await createFixture("joined");
    await db.insert(subjectPrivacyStates).values({
      twitchUserId: "broadcaster-1",
      publicProfileHidden: true,
      trackingOptedOut: true,
      updatedAt: observedAt
    });

    await assignments.record({
      type: "tracking_opt_out",
      broadcasterUserId: "broadcaster-1",
      observedAt
    });
    await assignments.record({
      type: "room_observed",
      botAccountId: fixture.botAccountId,
      broadcasterUserId: "broadcaster-1",
      observedAt: new Date(observedAt.getTime() + 1_000),
      lastMessageAt: new Date(observedAt.getTime() + 1_000)
    });

    const [assignment] = await db.select().from(chatAssignments).where(eq(chatAssignments.id, fixture.assignmentId));
    const events = await db.select().from(chatAssignmentEvents).where(eq(chatAssignmentEvents.chatAssignmentId, fixture.assignmentId));
    expect(assignment?.status).toBe("left");
    expect(events.map((event) => event.eventType)).toEqual(["left"]);
  });

  it("ignores delayed room observations for failed assignments", async () => {
    const fixture = await createFixture("failed");

    const changed = await assignments.record({
      type: "room_observed",
      botAccountId: fixture.botAccountId,
      broadcasterUserId: "broadcaster-1",
      observedAt
    });

    const [assignment] = await db.select().from(chatAssignments).where(eq(chatAssignments.id, fixture.assignmentId));
    expect(changed).toBe(0);
    expect(assignment?.status).toBe("failed");
    expect(await db.select().from(chatAssignmentEvents)).toEqual([]);
  });
});
