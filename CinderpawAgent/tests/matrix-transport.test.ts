import { describe, expect, it, afterEach } from "bun:test";
import { MatrixConnector, matrixSessionId, parseMatrixSession } from "../src/transports/matrix.ts";
import { ChannelAskRouter } from "../src/core/ask-user-channel.ts";
import type { ConnectorContext } from "../src/transports/registry.ts";
import type { AgentLike } from "../src/transports/connectors.ts";

const ROOM = "!abc:example.org";
const USER = "@sam:example.org";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A homeserver that answers exactly what the transport asks for, once. */
function fakeHomeserver(opts: {
  events?: unknown[];
  whoamiStatus?: number;
  syncStatus?: number;
}) {
  const sent: Array<{ path: string; body: unknown }> = [];
  let syncs = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    const path = href.replace("https://home.example", "");

    if (path.startsWith("/_matrix/client/v3/account/whoami")) {
      const status = opts.whoamiStatus ?? 200;
      return new Response(JSON.stringify({ user_id: "@cinderpaw:example.org" }), { status });
    }
    if (path.startsWith("/_matrix/client/v3/sync")) {
      syncs += 1;
      if (opts.syncStatus && opts.syncStatus !== 200) {
        return new Response("{}", { status: opts.syncStatus });
      }
      // First sync = backlog, cursor only. Second carries the events. After
      // that, nothing, so the loop idles instead of spinning.
      const events = syncs === 2 ? (opts.events ?? []) : [];
      return new Response(
        JSON.stringify({
          next_batch: `s${syncs}`,
          rooms: { join: { [ROOM]: { timeline: { events } } } },
        }),
        { status: 200 },
      );
    }
    if (path.includes("/send/m.room.message/")) {
      sent.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ event_id: "$1" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { sent, syncCount: () => syncs };
}

function ctxFor(over: Partial<ConnectorContext> = {}): ConnectorContext {
  const agent = {
    // `AgentLike.handle` resolves to the reply STRING.
    handle: async () => "hi back",
    setSessionSurface: () => {},
    setSessionProfile: () => {},
  } as unknown as AgentLike;
  return {
    row: {
      id: "matrix",
      enabled: true,
      allowlist: [USER],
      channels: [],
      metadata: { MATRIX_HOMESERVER: "https://home.example" },
      secrets: { MATRIX_ACCESS_TOKEN: "tok" },
    },
    secrets: { MATRIX_ACCESS_TOKEN: "tok" },
    agent,
    log: () => {},
    runs: null,
    askRouter: new ChannelAskRouter(),
    ...over,
  } as ConnectorContext;
}

const settle = () => new Promise((r) => setTimeout(r, 700));

describe("matrix session ids", () => {
  it("survives ids that contain colons of their own", () => {
    // `matrix:!abc:example.org:@sam:example.org` split on ":" gives five
    // pieces and a room that does not exist. This is why they are encoded.
    const s = matrixSessionId(ROOM, USER);
    expect(s.split(":")).toHaveLength(3);
    expect(parseMatrixSession(s)).toEqual({ roomId: ROOM, userId: USER });
  });

  it("does not claim a session id belonging to another connector", () => {
    expect(parseMatrixSession("slack:C1:U1")).toBeNull();
  });
});

describe("matrix transport", () => {
  it("takes the homeserver from config that is not a secret", async () => {
    const server = fakeHomeserver({});
    const c = new MatrixConnector();
    await c.start(ctxFor());
    expect(c.health()).toEqual({ live: true });
    await c.stop();
    expect(server.syncCount()).toBeGreaterThan(0);
  });

  it("says which setting is missing instead of failing silently", async () => {
    fakeHomeserver({});
    const c = new MatrixConnector();
    const ctx = ctxFor();
    ctx.row.metadata = {};
    await expect(c.start(ctx)).rejects.toThrow(/MATRIX_HOMESERVER/);
  });

  it("reads the homeserver from the old place too, so an existing config keeps working", async () => {
    fakeHomeserver({});
    const c = new MatrixConnector();
    const ctx = ctxFor();
    ctx.row.metadata = {};
    ctx.secrets = { ...ctx.secrets, MATRIX_HOMESERVER: "https://home.example" };
    await c.start(ctx);
    expect(c.health().live).toBe(true);
    await c.stop();
  });

  it("routes an inbound message to the agent and answers in the room", async () => {
    const server = fakeHomeserver({
      events: [
        {
          type: "m.room.message",
          sender: USER,
          event_id: "$e1",
          content: { msgtype: "m.text", body: "hello" },
        },
      ],
    });
    const c = new MatrixConnector();
    await c.start(ctxFor());
    await settle();
    await c.stop();

    expect(server.sent.length).toBeGreaterThan(0);
    expect(server.sent[0]!.path).toContain(encodeURIComponent(ROOM));
    expect((server.sent[0]!.body as { body: string }).body).toBe("hi back");
  });

  it("never answers its own messages", async () => {
    const server = fakeHomeserver({
      events: [
        {
          type: "m.room.message",
          sender: "@cinderpaw:example.org",
          content: { msgtype: "m.text", body: "hello" },
        },
      ],
    });
    const c = new MatrixConnector();
    await c.start(ctxFor());
    await settle();
    await c.stop();
    expect(server.sent).toHaveLength(0);
  });

  it("ignores a stranger when the allowlist does not name them", async () => {
    const server = fakeHomeserver({
      events: [
        {
          type: "m.room.message",
          sender: "@stranger:example.org",
          content: { msgtype: "m.text", body: "hello" },
        },
      ],
    });
    const c = new MatrixConnector();
    await c.start(ctxFor());
    await settle();
    await c.stop();
    expect(server.sent).toHaveLength(0);
  });

  it("refuses to start on a rejected token rather than reporting itself live", async () => {
    fakeHomeserver({ whoamiStatus: 401 });
    const c = new MatrixConnector();
    await expect(c.start(ctxFor())).rejects.toThrow(/revoked|rejected/i);
  });

  it("stops with a reason when the token is rejected mid-run", async () => {
    // A 401 will never fix itself. Retrying forever behind a green light is
    // the exact shape this connector surface exists to stop.
    fakeHomeserver({ syncStatus: 401 });
    const c = new MatrixConnector();
    await c.start(ctxFor());
    await settle();
    const h = c.health();
    expect(h.live).toBe(false);
    expect(h.error).toMatch(/reconnect/i);
    await c.stop();
  });
});
