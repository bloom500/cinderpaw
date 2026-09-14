/**
 * LINE on the inbound receiver: the boundary, end to end, with a fake LINE.
 *
 * `fetch` is replaced so `bot/info` and `message/push` never leave the
 * process, and the receiver is bound to port 0 so the OS picks a free one.
 * What is pinned is the order the decision record asks for: signature on
 * the raw bytes, then dedup, then allowlist, then the agent — and that a
 * machine with no webhook connector has no open port at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { ChannelAskRouter } from "../src/core/ask-user-channel.ts";
import { dispatch, inboundRoutes } from "../src/transports/inbound.ts";
import { LineConnector, lineSessionId, parseLineSession, verifyLineSignature } from "../src/transports/line.ts";
import type { ConnectorContext } from "../src/transports/registry.ts";

const SECRET = "channel-secret";
const realFetch = globalThis.fetch;

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("base64");
}

function event(userId: string, text: string, id = `ev-${Math.random()}`): string {
  return JSON.stringify({
    destination: "Ubot",
    events: [
      {
        type: "message",
        webhookEventId: id,
        deliveryContext: { isRedelivery: false },
        source: { type: "user", userId },
        message: { type: "text", id: "m1", text },
      },
    ],
  });
}

function post(body: string, signature: string | null = sign(body)): Request {
  return new Request("http://x/connectors/line", {
    method: "POST",
    body,
    headers: signature === null ? {} : { "x-line-signature": signature },
  });
}

/** Wait for the fire-and-forget event handling to reach the fake LINE. */
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("session ids", () => {
  test("a chat and a speaker make one session; `line` stays segment 0", () => {
    expect(lineSessionId("Cgroup", "Uuser")).toBe("line:Cgroup:Uuser");
    expect(parseLineSession("line:Cgroup:Uuser")).toEqual({ to: "Cgroup", userId: "Uuser" });
    expect(parseLineSession("telegram:1:2")).toBeNull();
  });
});

describe("the signature is checked on the raw bytes", () => {
  test("LINE's own scheme verifies; a byte changed or a header missing does not", () => {
    const body = Buffer.from('{"events":[]}');
    expect(verifyLineSignature(SECRET, body, sign('{"events":[]}'))).toBe(true);
    expect(verifyLineSignature(SECRET, Buffer.from('{"events":[] }'), sign('{"events":[]}'))).toBe(false);
    expect(verifyLineSignature(SECRET, body, null)).toBe(false);
    expect(verifyLineSignature(SECRET, body, "not base64!!")).toBe(false);
  });
});

describe("a webhook POST, end to end", () => {
  const pushed: Array<{ to: string; text: string }> = [];
  const handled: string[] = [];
  const logs: string[] = [];
  let connector: LineConnector;

  beforeEach(async () => {
    pushed.length = 0;
    handled.length = 0;
    logs.length = 0;
    process.env.CINDERPAW_INBOUND_PORT = "0";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/bot/info")) return new Response(JSON.stringify({ userId: "Ubot" }), { status: 200 });
      if (url.endsWith("/message/push")) {
        const b = JSON.parse(String(init?.body)) as { to: string; messages: Array<{ text: string }> };
        pushed.push({ to: b.to, text: b.messages[0]!.text });
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    connector = new LineConnector();
    const ctx: ConnectorContext = {
      row: { id: "line", enabled: true, allowlist: ["Uallowed"] },
      secrets: { LINE_CHANNEL_ACCESS_TOKEN: "tok", LINE_CHANNEL_SECRET: SECRET },
      agent: {
        async handle(sessionId, text) {
          handled.push(`${sessionId}|${text}`);
          return "the answer";
        },
      },
      log: (m) => logs.push(m),
      runs: null,
      askRouter: new ChannelAskRouter(),
    };
    await connector.start(ctx);
  });

  afterEach(async () => {
    await connector.stop();
    globalThis.fetch = realFetch;
    delete process.env.CINDERPAW_INBOUND_PORT;
  });

  test("start() opens exactly one route, and stop() closes the listener", async () => {
    expect(inboundRoutes()).toEqual(["/connectors/line"]);
    expect(connector.health()).toEqual({ live: true });
    expect(logs.some((l) => l.includes("/connectors/line"))).toBe(true);
    await connector.stop();
    expect(inboundRoutes()).toEqual([]);
    expect(logs.at(-1)).toContain("listener closed");
  });

  test("anything but POST /connectors/line is not served", async () => {
    expect((await dispatch(new Request("http://x/runtime"))).status).toBe(404);
    expect((await dispatch(new Request("http://x/connectors/telegram", { method: "POST" }))).status).toBe(404);
    expect((await dispatch(new Request("http://x/connectors/line"))).status).toBe(405);
  });

  test("a bad signature is 401 and nothing reaches the agent", async () => {
    const res = await dispatch(post(event("Uallowed", "hi"), sign("something else")));
    expect(res.status).toBe(401);
    await settle();
    expect(handled).toEqual([]);
    expect(logs.some((l) => l.includes("bad signature"))).toBe(true);
  });

  test("the console's Verify button (no events) gets a 200", async () => {
    expect((await dispatch(post('{"events":[]}'))).status).toBe(200);
  });

  test("an allowlisted user is answered by push; a stranger is ignored and told nothing", async () => {
    expect((await dispatch(post(event("Uallowed", "hello")))).status).toBe(200);
    expect((await dispatch(post(event("Ustranger", "hello")))).status).toBe(200);
    await settle();
    expect(handled).toEqual(["line:Uallowed:Uallowed|[user:Uallowed] hello"]);
    expect(pushed).toEqual([{ to: "Uallowed", text: "the answer" }]);
    expect(logs.some((l) => l.includes("non-allowlisted Ustranger"))).toBe(true);
  });

  test("a redelivered event is handled once", async () => {
    const body = event("Uallowed", "again", "same-id");
    await dispatch(post(body));
    await dispatch(post(body));
    await settle();
    expect(handled).toHaveLength(1);
  });
});
