import { EventEmitter } from "node:events";
import { connect, type TLSSocket } from "node:tls";
import type { IrcConnectionEvents, ParsedIrcMessage, TwitchIrcAdapter } from "./types.js";

export const parseIrcLine = (rawLine: string): ParsedIrcMessage => {
  let rest = rawLine;
  const tags: Record<string, string> = {};
  let prefix: string | null = null;

  if (rest.startsWith("@")) {
    const [rawTags, next] = splitFirst(rest, " ");
    rest = next;
    for (const tag of rawTags.slice(1).split(";")) {
      const [key, value = ""] = tag.split("=", 2);
      if (key != null && key !== "") {
        tags[key] = value;
      }
    }
  }

  if (rest.startsWith(":")) {
    const [rawPrefix, next] = splitFirst(rest, " ");
    prefix = rawPrefix.slice(1);
    rest = next;
  }

  let trailing: string | null = null;
  const trailingIndex = rest.indexOf(" :");
  if (trailingIndex >= 0) {
    trailing = rest.slice(trailingIndex + 2);
    rest = rest.slice(0, trailingIndex);
  }

  const [command = "", ...params] = rest.split(" ").filter(Boolean);

  return {
    rawLine,
    tags,
    prefix,
    command,
    params,
    trailing
  };
};

const splitFirst = (value: string, separator: string): [string, string] => {
  const index = value.indexOf(separator);
  if (index === -1) {
    return [value, ""];
  }

  return [value.slice(0, index), value.slice(index + separator.length)];
};

export class DisabledIrcAdapter extends EventEmitter implements TwitchIrcAdapter {
  constructor(private readonly events: IrcConnectionEvents) {
    super();
  }

  async connect(): Promise<void> {
    await this.events.connected?.();
  }

  async join(channelLogin: string): Promise<void> {
    await this.events.rawMessage(parseIrcLine(`:disabled JOIN #${channelLogin}`));
  }

  async part(channelLogin: string): Promise<void> {
    await this.events.rawMessage(parseIrcLine(`:disabled PART #${channelLogin}`));
  }

  async disconnect(reason: string): Promise<void> {
    await this.events.disconnected?.(reason);
  }
}

export class SocketIrcAdapter extends EventEmitter implements TwitchIrcAdapter {
  private socket: TLSSocket | null = null;
  private buffer = "";
  private disconnectedNotified = false;

  constructor(
    private readonly input: {
      login: string;
      oauthToken: string;
      events: IrcConnectionEvents;
      host?: string;
      port?: number;
    }
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.socket != null && !this.socket.destroyed) {
      return;
    }

    this.disconnectedNotified = false;
    await new Promise<void>((resolve, reject) => {
      const socket = connect({
        host: this.input.host ?? "irc.chat.twitch.tv",
        port: this.input.port ?? 6697,
        servername: this.input.host ?? "irc.chat.twitch.tv"
      });
      this.socket = socket;
      socket.setEncoding("utf8");

      socket.once("secureConnect", () => {
        this.writeLine("CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership");
        this.writeLine(`PASS ${formatOauthToken(this.input.oauthToken)}`);
        this.writeLine(`NICK ${this.input.login}`);
        void this.input.events.connected?.();
        resolve();
      });

      socket.on("data", (chunk) => {
        this.handleData(String(chunk));
      });

      socket.on("error", (error) => {
        void this.input.events.error?.(error);
        reject(error);
      });

      socket.on("close", () => {
        void this.notifyDisconnected("socket_closed");
      });
    });
  }

  async join(channelLogin: string): Promise<void> {
    this.writeLine(`JOIN #${channelLogin.toLowerCase()}`);
  }

  async part(channelLogin: string): Promise<void> {
    this.writeLine(`PART #${channelLogin.toLowerCase()}`);
  }

  async disconnect(reason: string): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (socket == null || socket.destroyed) {
      await this.notifyDisconnected(reason);
      return;
    }

    socket.end();
    await this.notifyDisconnected(reason);
  }

  private handleData(chunk: string) {
    this.buffer += chunk;
    let boundary = this.buffer.indexOf("\r\n");

    while (boundary >= 0) {
      const line = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      if (line !== "") {
        const message = parseIrcLine(line);
        if (message.command === "PING") {
          this.writeLine(`PONG :${message.trailing ?? "tmi.twitch.tv"}`);
        }
        void this.input.events.rawMessage(message);
      }
      boundary = this.buffer.indexOf("\r\n");
    }
  }

  private writeLine(line: string) {
    if (this.socket == null || this.socket.destroyed) {
      throw new Error("IRC socket is not connected.");
    }

    this.socket.write(`${line}\r\n`);
  }

  private async notifyDisconnected(reason: string) {
    if (this.disconnectedNotified) {
      return;
    }

    this.disconnectedNotified = true;
    await this.input.events.disconnected?.(reason);
  }
}

const formatOauthToken = (token: string) => {
  return token.startsWith("oauth:") ? token : `oauth:${token}`;
};
