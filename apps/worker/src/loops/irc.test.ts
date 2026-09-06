import { loadConfig } from "@twitch-tracker/config";
import { chatMessages, rawIrcMessages, streamSessions, twitchUsers, type DbClient } from "@twitch-tracker/db";
import { DisabledHelixAdapter, type IrcConnectionEvents } from "@twitch-tracker/twitch";
import { describe, expect, it, vi } from "vitest";
import { runIrcLoop } from "./irc.js";

const fixture = vi.hoisted(() => ({ line: "" }));

vi.mock("@twitch-tracker/twitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@twitch-tracker/twitch")>();
  return {
    ...actual,
    SocketIrcAdapter: class {
      constructor(private readonly input: { events: IrcConnectionEvents }) {}
      async connect() {
        await this.input.events.connected?.();
        await this.input.events.rawMessage(actual.parseIrcLine(fixture.line));
      }
      async disconnect() {}
    }
  };
});

vi.mock("../bot-auth.js", () => ({
  resolveBotCredentialsPool: async () => [{
    botAccountId: "bot", login: "tracker", accessToken: "synthetic-test-token",
    maxJoinedRooms: 10, joinRatePer10Seconds: 1
  }]
}));

vi.mock("./common.js", () => ({
  startIntervalLoop: async (input: { run: () => Promise<Record<string, unknown>> }) => {
    const result = await input.run();
    expect(result.failedBotAccounts).toBe(0);
  }
}));

vi.mock("@twitch-tracker/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@twitch-tracker/db")>();
  return {
    ...actual,
    createChatAssignmentControl: () => ({
      record: async () => undefined,
      planIrcCommands: async () => ({
        leave: [], join: [], roomReservations: 0, availableRoomSlots: 10, staleJoiningRequeued: 0
      })
    })
  };
});

describe("IRC Shared Chat persistence", () => {
  it.each([
    { name: "relayed message", sourceTag: ";source-room-id=100;source-id=original-message", expectedSource: "100" },
    { name: "original message in a shared room", sourceTag: ";source-room-id=200;source-id=received-message", expectedSource: "200" },
    { name: "ordinary message", sourceTag: "", expectedSource: null },
    { name: "empty source tag", sourceTag: ";source-room-id=", expectedSource: null }
  ])("preserves channel attribution for $name", async ({ sourceTag, expectedSource }) => {
    fixture.line = `@id=received-message;room-id=200;user-id=300;display-name=Chatter;tmi-sent-ts=1788696000000${sourceTag} :chatter!chatter@chatter.tmi.twitch.tv PRIVMSG #channel :Test message`;
    const messages: Array<typeof chatMessages.$inferInsert> = [];
    const rawLines: string[] = [];
    const db = {
      insert: (table: unknown) => ({
        values: (value: typeof chatMessages.$inferInsert & typeof rawIrcMessages.$inferInsert) => {
          if (table === chatMessages) messages.push(value);
          if (table === rawIrcMessages) rawLines.push(value.rawLine!);
          return {
            returning: async () => [{ id: "raw-message" }],
            onConflictDoNothing: async () => undefined,
            onConflictDoUpdate: async () => undefined
          };
        }
      }),
      select: () => ({
        from: (table: unknown) => {
          const rows = table === twitchUsers ? [{ twitchUserId: "200" }]
            : table === streamSessions ? [{ twitchStreamId: "stream" }] : [];
          return {
            where: () => ({
              limit: async () => rows,
              orderBy: () => ({ limit: async () => rows })
            })
          };
        }
      })
    } as unknown as DbClient;

    await runIrcLoop({
      config: loadConfig({
        DATABASE_URL: "postgres://localhost/unused_test", SESSION_SECRET: "s".repeat(48),
        ENABLE_TWITCH_INGESTION: "true"
      }),
      db, rest: new DisabledHelixAdapter(), workerName: "test-worker",
      abortSignal: new AbortController().signal
    });

    expect(rawLines).toEqual([fixture.line]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      twitchMessageId: "received-message",
      broadcasterUserId: "200",
      twitchStreamId: "stream",
      chatterUserId: "300",
      sharedChatSourceChannelId: expectedSource,
      rawIrcMessageId: "raw-message"
    });
  });
});
