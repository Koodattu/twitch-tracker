import { loadConfig } from "@twitch-tracker/config";
import { streamSessions, twitchUsers, type DbClient } from "@twitch-tracker/db";
import { DisabledHelixAdapter, parseIrcLine, type IrcConnectionEvents } from "@twitch-tracker/twitch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runIrcLoop } from "./irc.js";

const fixture = vi.hoisted(() => ({
  events: [] as IrcConnectionEvents[],
  run: undefined as (() => Promise<Record<string, unknown>>) | undefined,
  completion: Promise.resolve(),
  status: "joined",
  record: vi.fn(),
  join: vi.fn()
}));

vi.mock("@twitch-tracker/twitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@twitch-tracker/twitch")>();
  return {
    ...actual,
    SocketIrcAdapter: class {
      private disconnected = false;
      constructor(private readonly input: { events: IrcConnectionEvents }) {
        fixture.events.push(input.events);
      }
      async connect() { await this.input.events.connected?.(); }
      async join(channel: string) { fixture.join(channel); }
      async disconnect(reason: string) {
        if (this.disconnected) return;
        this.disconnected = true;
        await this.input.events.disconnected?.(reason);
      }
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
  startIntervalLoop: (input: { run: () => Promise<Record<string, unknown>> }) => {
    fixture.run = input.run;
    return fixture.completion;
  }
}));

vi.mock("@twitch-tracker/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@twitch-tracker/db")>();
  return {
    ...actual,
    createChatAssignmentControl: () => ({
      record: fixture.record,
      planIrcCommands: async () => ({
        leave: [],
        join: fixture.status === "desired" ? [{ assignmentId: "assignment", channelLogin: "channel" }] : [],
        roomReservations: 0, availableRoomSlots: 10, staleJoiningRequeued: 0
      })
    })
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  fixture.events = [];
  fixture.status = "joined";
  fixture.record.mockImplementation(async (event: { type: string }) => {
    if (event.type === "socket_disconnected") fixture.status = "desired";
    if (event.type === "room_observed") fixture.status = "joined";
    if (event.type === "join_command_sent") fixture.status = "joining";
  });
});

const start = async () => {
  const stop = Promise.withResolvers<void>();
  fixture.completion = stop.promise;
  const returning = vi.fn(async () => [{ id: "raw-message" }]);
  const saveMessage = vi.fn(async () => undefined);
  const db = {
    insert: () => ({ values: () => ({ returning, onConflictDoNothing: saveMessage }) }),
    select: () => ({
      from: (table: unknown) => {
        const rows = table === twitchUsers ? [{ twitchUserId: "channel-id" }]
          : table === streamSessions ? [{ twitchStreamId: "stream" }] : [];
        return { where: () => ({ limit: async () => rows, orderBy: () => ({ limit: async () => rows }) }) };
      }
    })
  } as unknown as DbClient;
  const completion = runIrcLoop({
    config: loadConfig({
      DATABASE_URL: "postgres://localhost/unused_test", SESSION_SECRET: "s".repeat(48),
      ENABLE_TWITCH_INGESTION: "true"
    }),
    db, rest: new DisabledHelixAdapter(), workerName: "test-worker",
    abortSignal: new AbortController().signal
  });
  expect((await fixture.run!()).failedBotAccounts).toBe(0);
  return { stop: stop.resolve, completion, returning, saveMessage, events: fixture.events[0]! };
};

describe("IRC connection lifecycle", () => {
  it("rejoins rooms left marked joined by a previous worker", async () => {
    const worker = await start();
    expect(fixture.join).toHaveBeenCalledWith("channel");
    expect(fixture.status).toBe("joining");
    worker.stop();
    await worker.completion;
  });

  it.each(["ROOMSTATE", "PRIVMSG"])("finishes an in-flight %s before shutdown requeues rooms", async (command) => {
    const worker = await start();
    const pending = Promise.withResolvers<Array<{ id: string }>>();
    worker.returning.mockReturnValueOnce(pending.promise);
    const message = worker.events.rawMessage(parseIrcLine(`:tmi.twitch.tv ${command} #channel :Test message`));
    worker.stop();
    let stopped = false;
    void worker.completion.then(() => { stopped = true; });
    await Promise.resolve();
    await Promise.resolve();
    await worker.events.rawMessage(parseIrcLine(":tmi.twitch.tv ROOMSTATE #channel"));
    const writesBeforeDrain = worker.returning.mock.calls.length;
    const stoppedBeforeDrain = stopped;
    pending.resolve([{ id: "raw-message" }]);
    await message;
    await worker.completion;

    expect(writesBeforeDrain).toBe(1);
    expect(stoppedBeforeDrain).toBe(false);
    expect(stopped).toBe(true);
    expect(worker.saveMessage).toHaveBeenCalledTimes(command === "PRIVMSG" ? 1 : 0);
    expect(fixture.status).toBe("desired");
    expect(fixture.record).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "socket_disconnected", reason: "worker_shutdown"
    }));
  });

  it("waits for a closing connection before reconnecting and ignores its late messages", async () => {
    const worker = await start();
    const pending = Promise.withResolvers<Array<{ id: string }>>();
    worker.returning.mockReturnValueOnce(pending.promise);
    const message = worker.events.rawMessage(parseIrcLine(":tmi.twitch.tv ROOMSTATE #channel"));
    const disconnected = worker.events.disconnected!("socket_closed");
    const nextRun = fixture.run!();
    await Promise.resolve();
    await Promise.resolve();
    const connectionsBeforeDrain = fixture.events.length;
    pending.resolve([{ id: "raw-message" }]);
    await message;
    await disconnected;
    expect((await nextRun).failedBotAccounts).toBe(0);
    await worker.events.rawMessage(parseIrcLine(":tmi.twitch.tv ROOMSTATE #channel"));
    await worker.events.disconnected!("socket_closed");

    expect(connectionsBeforeDrain).toBe(1);
    expect(fixture.events).toHaveLength(2);
    expect(fixture.join).toHaveBeenCalledTimes(2);
    expect(fixture.status).toBe("joining");
    expect(worker.returning).toHaveBeenCalledTimes(1);
    worker.stop();
    await worker.completion;
  });

  it("handles a Twitch RECONNECT message without waiting on its own callback", async () => {
    const worker = await start();
    await worker.events.rawMessage(parseIrcLine(":tmi.twitch.tv RECONNECT"));
    expect(fixture.record).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "socket_disconnected", reason: "twitch_reconnect"
    }));
    expect((await fixture.run!()).failedBotAccounts).toBe(0);
    expect(fixture.join).toHaveBeenCalledTimes(2);
    worker.stop();
    await worker.completion;
  });
});
