/**
 * Tlon against a fake ship: login, channel open, SSE firehose, pokes.
 *
 * The fake answers /~/login with a cookie, records every channel PUT, and
 * serves one SSE stream: a DM-invite array (from an allowlisted ship and a
 * stranger), then one DM. Pinned: the invite is accepted only for the
 * allowlisted ship, the DM is answered with a chat-dm-action whose id is
 * `~bot/<@ud>`, every event is acked, and the @da arithmetic matches aura.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ChannelAskRouter } from "../src/core/ask-user-channel.ts";
import { TlonConnector, daUdFromUnix, normalizeShip, storyText, tlonSessionId } from "../src/transports/tlon.ts";
import type { ConnectorContext } from "../src/transports/registry.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function sse(events: Array<{ id: number; json: unknown }>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`id: ${e.id}\ndata: ${JSON.stringify({ id: 2, response: "diff", json: e.json })}\n\n`));
      // Keep the stream open: a closed stream would make the connector reconnect in a loop.
    },
  });
}

describe("pieces", () => {
  test("ship names normalise with the sig; garbage is refused", () => {
    expect(normalizeShip("Sampel-Palnet")).toBe("~sampel-palnet");
    expect(normalizeShip("~sampel-palnet ")).toBe("~sampel-palnet");
    expect(normalizeShip("not a ship!")).toBe("");
    expect(tlonSessionId("~zod")).toBe("tlon:~zod");
  });
  test("@da at the unix epoch matches aura's constant, dotted as @ud", () => {
    expect(daUdFromUnix(0)).toBe("170.141.184.475.152.167.957.503.069.145.530.368.000");
  });
  test("a story's inline runs become text, ships included", () => {
    expect(storyText([{ inline: ["hi ", { ship: "~zod" }, { break: {} }] }, { inline: [{ bold: ["!"] }] }])).toBe("hi ~zod\n\n!");
    expect(storyText("nope")).toBe("");
  });
});

describe("a ship, end to end", () => {
  test("invite accepted for the allowlisted ship only; the DM is answered and every event acked", async () => {
    const puts: Array<Record<string, unknown>> = [];
    const handled: string[] = [];
    const logs: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/~/login")) return new Response(null, { status: 204, headers: { "set-cookie": "urbauth-~bot=abc; Path=/" } });
      if (url.includes("/~/channel/") && init?.method === "PUT") {
        for (const a of JSON.parse(String(init.body)) as Record<string, unknown>[]) puts.push(a);
        return new Response(null, { status: 204 });
      }
      if (url.includes("/~/channel/")) {
        return new Response(
          sse([
            { id: 1, json: [{ ship: "~friend" }, { ship: "~stranger" }] },
            { id: 2, json: { whom: "~friend", id: "~friend/1", response: { add: { essay: { author: "~friend", content: [{ inline: ["hello"] }], sent: 1 } } } } },
            { id: 3, json: { whom: "~bot", id: "~bot/2", response: { add: { essay: { author: "~bot", content: [{ inline: ["me"] }] } } } } },
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const c = new TlonConnector();
    const ctx: ConnectorContext = {
      row: { id: "tlon", enabled: true, allowlist: ["~friend"], metadata: { TLON_SHIP: "~bot", TLON_URL: "http://ship.test" } },
      secrets: { TLON_CODE: "lidlut-tabwed-pillex-ridrup" },
      agent: { async handle(sessionId, t) { handled.push(`${sessionId}|${t}`); return "the answer"; } },
      log: (m) => logs.push(m),
      runs: null,
      askRouter: new ChannelAskRouter(),
    };
    await c.start(ctx);
    expect(c.health()).toEqual({ live: true });
    await settle();

    expect(puts.filter((a) => a.action === "subscribe")).toEqual([expect.objectContaining({ app: "chat", path: "/v3", ship: "bot" })]);
    const rsvps = puts.filter((a) => a.mark === "chat-dm-rsvp").map((a) => (a.json as { ship: string }).ship);
    expect(rsvps).toEqual(["~friend"]);
    expect(handled).toEqual(["tlon:~friend|[user:~friend] hello"]);
    const dm = puts.find((a) => a.mark === "chat-dm-action")!.json as { ship: string; diff: { id: string; delta: { add: { memo: { content: unknown; author: string } } } } };
    expect(dm.ship).toBe("~friend");
    expect(dm.diff.id).toMatch(/^~bot\/\d{3}(\.\d{3})+$/);
    expect(dm.diff.delta.add.memo).toMatchObject({ author: "~bot", content: [{ inline: ["the answer"] }] });
    expect(puts.filter((a) => a.action === "ack").map((a) => a["event-id"])).toEqual([1, 2, 3]);
    await c.stop();
    expect(puts.at(-1)).toMatchObject({ action: "delete" });
  });

  test("a wrong access code is said in words", async () => {
    globalThis.fetch = (async () => new Response("bad", { status: 400 })) as typeof fetch;
    const c = new TlonConnector();
    await expect(
      c.start({
        row: { id: "tlon", enabled: true, metadata: { TLON_SHIP: "~bot", TLON_URL: "http://ship.test" } },
        secrets: { TLON_CODE: "nope" },
        agent: { async handle() { return ""; } },
        log: () => {},
        runs: null,
        askRouter: new ChannelAskRouter(),
      }),
    ).rejects.toThrow(/\+code in the dojo/);
  });
});
