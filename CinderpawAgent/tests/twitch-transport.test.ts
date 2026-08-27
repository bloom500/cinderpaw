import { describe, expect, it, afterEach } from "bun:test";
import { TwitchConnector, parsePrivmsg, parseTwitchSession } from "../src/transports/twitch.ts";
import { ChannelAskRouter } from "../src/core/ask-user-channel.ts";
import type { ConnectorContext } from "../src/transports/registry.ts";
import type { AgentLike } from "../src/transports/connectors.ts";

const RealWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.WebSocket = RealWebSocket;
});

class FakeSocket {
  static last: FakeSocket | null = null;
  readonly sent: string[] = [];
  #listeners: Record<string, Array<(ev: unknown) => void>> = {};
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.#listeners[type] ??= []).push(fn);
  }
  send(data: string) {
    this.sent.push(data.replace(/\r\n$/, ""));
  }
  close() {
    this.closed = true;
  }
  emit(type: string, ev: unknown) {
    for (const fn of this.#listeners[type] ?? []) fn(ev);
  }
  open() {
    this.emit("open", {});
  }
  /** Deliver raw IRC lines the way Twitch does — several per frame. */
  lines(...lines: string[]) {
    this.emit("message", { data: `${lines.join("\r\n")}\r\n` });
  }
}

function useFakeSocket() {
  FakeSocket.last = null;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
}

function ctxFor(over: { secrets?: Record<string, string>; metadata?: Record<string, string> } = {}): ConnectorContext {
  const agent = {
    handle: async () => "hi back",
    setSessionSurface: () => {},
    setSessionProfile: () => {},
  } as unknown as AgentLike;
  return {
    row: {
      id: "twitch",
      enabled: true,
      allowlist: ["sam"],
      channels: ["#CinderpawStream"],
      metadata: over.metadata ?? { TWITCH_LOGIN: "cinderpawbot" },
      secrets: {},
    },
    secrets: over.secrets ?? { OAUTH_ACCESS: "acc" },
    agent,
    log: () => {},
    runs: null,
    askRouter: new ChannelAskRouter(),
  } as ConnectorContext;
}

const settle = () => new Promise((r) => setTimeout(r, 50));
const WELCOME = ":tmi.twitch.tv 001 cinderpawbot :Welcome, GLHF!";

describe("twitch line parsing", () => {
  it("reads a tagged PRIVMSG", () => {
    expect(
      parsePrivmsg("@badge-info=;id=1 :sam!sam@sam.tmi.twitch.tv PRIVMSG #cinderpawstream :hello there"),
    ).toEqual({ user: "sam", channel: "cinderpawstream", text: "hello there" });
  });
  it("reads an untagged one", () => {
    expect(parsePrivmsg(":sam!sam@sam.tmi.twitch.tv PRIVMSG #chan :hi")).toEqual({
      user: "sam",
      channel: "chan",
      text: "hi",
    });
  });
  it("is not fooled by another command", () => {
    expect(parsePrivmsg(":tmi.twitch.tv NOTICE * :Login authentication failed")).toBeNull();
  });
  it("round-trips a session id", () => {
    expect(parseTwitchSession("twitch:chan:sam")).toEqual({ channel: "chan", user: "sam" });
  });
});

describe("twitch transport", () => {
  it("authenticates with the token from the vault and joins the channels", async () => {
    useFakeSocket();
    const c = new TwitchConnector();
    await c.start(ctxFor());
    const s = FakeSocket.last!;
    s.open();

    expect(s.sent).toContain("PASS oauth:acc");
    expect(s.sent).toContain("NICK cinderpawbot");
    // Not live until Twitch says hello — an open socket is not a login.
    expect(c.health().live).toBe(false);

    s.lines(WELCOME);
    expect(c.health()).toEqual({ live: true });
    expect(s.sent).toContain("JOIN #cinderpawstream");
    await c.stop();
  });

  it("refuses to start when the account has never been paired", async () => {
    useFakeSocket();
    await expect(new TwitchConnector().start(ctxFor({ secrets: {} }))).rejects.toThrow(/pair/i);
  });

  it("says the account name is missing rather than failing at the server", async () => {
    useFakeSocket();
    await expect(new TwitchConnector().start(ctxFor({ metadata: {} }))).rejects.toThrow(/account name/i);
  });

  it("answers PING so the server does not hang up on it", async () => {
    useFakeSocket();
    const c = new TwitchConnector();
    await c.start(ctxFor());
    const s = FakeSocket.last!;
    s.open();
    s.lines("PING :tmi.twitch.tv");
    expect(s.sent).toContain("PONG :tmi.twitch.tv");
    await c.stop();
  });

  it("stops with a reason when the login is refused, instead of retrying forever", async () => {
    // This is what an expired or revoked token looks like from inside chat.
    // Retrying it behind a green light is the silence this surface exists to
    // end — and renewal is the host's job, so the state has to be legible.
    useFakeSocket();
    const c = new TwitchConnector();
    await c.start(ctxFor());
    const s = FakeSocket.last!;
    s.open();
    s.lines(":tmi.twitch.tv NOTICE * :Login authentication failed");

    const h = c.health();
    expect(h.live).toBe(false);
    expect(h.error).toMatch(/renew/i);
    expect(s.closed).toBe(true);
    await c.stop();
  });

  it("routes a chat message to the agent and answers in the channel", async () => {
    useFakeSocket();
    const c = new TwitchConnector();
    await c.start(ctxFor());
    const s = FakeSocket.last!;
    s.open();
    s.lines(WELCOME, ":sam!sam@sam.tmi.twitch.tv PRIVMSG #cinderpawstream :hello");
    await settle();

    expect(s.sent).toContain("PRIVMSG #cinderpawstream :hi back");
    await c.stop();
  });

  it("ignores a viewer the allowlist does not name", async () => {
    useFakeSocket();
    const c = new TwitchConnector();
    await c.start(ctxFor());
    const s = FakeSocket.last!;
    s.open();
    s.lines(WELCOME, ":rando!rando@rando.tmi.twitch.tv PRIVMSG #cinderpawstream :hello");
    await settle();

    expect(s.sent.some((l) => l.startsWith("PRIVMSG"))).toBe(false);
    await c.stop();
  });

  it("joins its own channel when none is configured, rather than nothing", async () => {
    // A Twitch bot in no channel is connected to nothing, and looks exactly
    // like a broken token from the outside.
    useFakeSocket();
    const c = new TwitchConnector();
    const ctx = ctxFor();
    ctx.row.channels = [];
    await c.start(ctx);
    const s = FakeSocket.last!;
    s.open();
    s.lines(WELCOME);
    expect(s.sent).toContain("JOIN #cinderpawbot");
    await c.stop();
  });
});
