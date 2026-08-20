import { describe, expect, it, afterEach } from "bun:test";
import {
  MattermostConnector,
  mattermostSessionId,
  parseMattermostSession,
} from "../src/transports/mattermost.ts";
import { ChannelAskRouter } from "../src/core/ask-user-channel.ts";
import type { ConnectorContext } from "../src/transports/registry.ts";
import type { AgentLike } from "../src/transports/connectors.ts";

const CHANNEL = "chan1";
const USER = "user1";
const SELF = "feralbot";

const realFetch = globalThis.fetch;
const RealWebSocket = globalThis.WebSocket;
afterEach(() => {
  globalThis.fetch = realFetch;
  globalThis.WebSocket = RealWebSocket;
});

/** A Mattermost that answers `/users/me` and records posts. */
function fakeServer(opts: { meStatus?: number } = {}) {
  const posts: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace("https://chat.example", "");
    if (path === "/api/v4/users/me") {
      return new Response(JSON.stringify({ id: SELF }), { status: opts.meStatus ?? 200 });
    }
    if (path === "/api/v4/posts") {
      posts.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("{}", { status: 201 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { posts };
}

/** A socket that never connects on its own; the test pushes frames into it. */
class FakeSocket {
  static last: FakeSocket | null = null;
  readonly url: string;
  readonly headers: Record<string, string>;
  #listeners: Record<string, Array<(ev: unknown) => void>> = {};
  closed = false;

  constructor(url: string, opts?: { headers?: Record<string, string> }) {
    this.url = url;
    this.headers = opts?.headers ?? {};
    FakeSocket.last = this;
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.#listeners[type] ??= []).push(fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, ev: unknown) {
    for (const fn of this.#listeners[type] ?? []) fn(ev);
  }
  /** Deliver one Mattermost frame. */
  push(frame: unknown) {
    this.emit("message", { data: JSON.stringify(frame) });
  }
}

function useFakeSocket() {
  FakeSocket.last = null;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
}

function ctxFor(): ConnectorContext {
  const agent = {
    handle: async () => "hi back",
    setSessionSurface: () => {},
    setSessionProfile: () => {},
  } as unknown as AgentLike;
  return {
    row: {
      id: "mattermost",
      enabled: true,
      allowlist: [USER],
      channels: [],
      metadata: { MATTERMOST_URL: "https://chat.example" },
      secrets: { MATTERMOST_TOKEN: "tok" },
    },
    secrets: { MATTERMOST_TOKEN: "tok" },
    agent,
    log: () => {},
    runs: null,
    askRouter: new ChannelAskRouter(),
  } as ConnectorContext;
}

const posted = (over: Record<string, unknown> = {}) => ({
  event: "posted",
  data: {
    // Mattermost sends the post as a JSON STRING inside the frame.
    post: JSON.stringify({
      id: "p1",
      user_id: USER,
      channel_id: CHANNEL,
      message: "hello",
      ...over,
    }),
  },
});

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("mattermost session ids", () => {
  it("round-trips", () => {
    expect(parseMattermostSession(mattermostSessionId(CHANNEL, USER))).toEqual({
      channelId: CHANNEL,
      userId: USER,
    });
  });
  it("does not claim another connector's session", () => {
    expect(parseMattermostSession("matrix:a:b")).toBeNull();
  });
});

describe("mattermost transport", () => {
  it("authenticates the socket with the same token as the API", async () => {
    fakeServer();
    useFakeSocket();
    const c = new MattermostConnector();
    await c.start(ctxFor());

    expect(FakeSocket.last?.url).toBe("wss://chat.example/api/v4/websocket");
    expect(FakeSocket.last?.headers.Authorization).toBe("Bearer tok");
    expect(c.health()).toEqual({ live: true });
    await c.stop();
    expect(FakeSocket.last?.closed).toBe(true);
  });

  it("says which setting is missing instead of failing silently", async () => {
    fakeServer();
    useFakeSocket();
    const ctx = ctxFor();
    ctx.row.metadata = {};
    await expect(new MattermostConnector().start(ctx)).rejects.toThrow(/MATTERMOST_URL/);
  });

  it("routes a post to the agent and answers in the channel", async () => {
    const server = fakeServer();
    useFakeSocket();
    const c = new MattermostConnector();
    await c.start(ctxFor());
    FakeSocket.last!.push(posted());
    await settle();
    await c.stop();

    expect(server.posts).toHaveLength(1);
    expect(server.posts[0]).toEqual({ channel_id: CHANNEL, message: "hi back" });
  });

  it("never answers its own posts", async () => {
    const server = fakeServer();
    useFakeSocket();
    const c = new MattermostConnector();
    await c.start(ctxFor());
    FakeSocket.last!.push(posted({ user_id: SELF }));
    await settle();
    await c.stop();
    expect(server.posts).toHaveLength(0);
  });

  it("ignores a stranger the allowlist does not name", async () => {
    const server = fakeServer();
    useFakeSocket();
    const c = new MattermostConnector();
    await c.start(ctxFor());
    FakeSocket.last!.push(posted({ user_id: "someone-else" }));
    await settle();
    await c.stop();
    expect(server.posts).toHaveLength(0);
  });

  it("refuses to start on a revoked token rather than reporting itself live", async () => {
    fakeServer({ meStatus: 401 });
    useFakeSocket();
    await expect(new MattermostConnector().start(ctxFor())).rejects.toThrow(/revoked|rejected/i);
  });

  it("reports a dropped connection instead of looking healthy", async () => {
    fakeServer();
    useFakeSocket();
    const c = new MattermostConnector();
    await c.start(ctxFor());
    FakeSocket.last!.emit("close", {});
    const h = c.health();
    expect(h.live).toBe(false);
    expect(h.error).toMatch(/dropped/i);
    await c.stop();
  });

  it("survives a frame it cannot read", async () => {
    const server = fakeServer();
    useFakeSocket();
    const c = new MattermostConnector();
    await c.start(ctxFor());
    // Garbage, a frame with no post, and a post that is not JSON. None of
    // these may take the connector down.
    FakeSocket.last!.emit("message", { data: "not json at all" });
    FakeSocket.last!.push({ event: "posted", data: {} });
    FakeSocket.last!.push({ event: "typing", data: {} });
    await settle();
    expect(c.health()).toEqual({ live: true });
    expect(server.posts).toHaveLength(0);
    await c.stop();
  });
});
