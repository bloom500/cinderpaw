/**
 * Synology Chat on the inbound receiver, with a fake NAS.
 *
 * What is new here: no HMAC, the outgoing webhook's token in the form is the
 * proof; and the default loopback bind is a silent failure for a NAS, so
 * start() must say so on screen.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChannelAskRouter } from "../src/core/ask-user-channel.ts";
import { dispatch } from "../src/transports/inbound.ts";
import {
  SynologyChatConnector,
  synologySessionId,
  parseSynologySession,
  verifySynologyToken,
} from "../src/transports/synology-chat.ts";
import type { ConnectorContext } from "../src/transports/registry.ts";

const TOKEN = "outgoing-token";
const INCOMING = "https://nas.local/webapi/entry.cgi?api=SYNO.Chat.External&token=abc";
const realFetch = globalThis.fetch;

function post(fields: Record<string, string>): Request {
  return new Request("http://x/connectors/synology-chat", {
    method: "POST",
    body: new URLSearchParams(fields).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}
const msg = (user_id: string, text: string, post_id = `${Math.random()}`, token = TOKEN) =>
  post({ token, user_id, username: "darius", text, post_id, channel_id: "1" });

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("session ids and the token", () => {
  test("the Chat user id is the session", () => {
    expect(synologySessionId("5")).toBe("synology-chat:5");
    expect(parseSynologySession("synology-chat:5")).toEqual({ userId: "5" });
    expect(parseSynologySession("sms:+1")).toBeNull();
  });
  test("the token must match exactly; missing or different is refused", () => {
    expect(verifySynologyToken(TOKEN, TOKEN)).toBe(true);
    expect(verifySynologyToken(TOKEN, "outgoing-tokem")).toBe(false);
    expect(verifySynologyToken(TOKEN, null)).toBe(false);
  });
});

describe("a NAS webhook, end to end", () => {
  const sent: Array<{ text: string; user_ids: number[] }> = [];
  const handled: string[] = [];
  const logs: string[] = [];
  let connector: SynologyChatConnector;

  const ctx = (): ConnectorContext => ({
    row: { id: "synology-chat", enabled: true, allowlist: ["5"] },
    secrets: { SYNOLOGY_CHAT_WEBHOOK_URL: INCOMING, SYNOLOGY_CHAT_TOKEN: TOKEN },
    agent: {
      async handle(sessionId, t) {
        handled.push(`${sessionId}|${t}`);
        return "the answer";
      },
    },
    log: (m) => logs.push(m),
    runs: null,
    askRouter: new ChannelAskRouter(),
  });

  beforeEach(async () => {
    sent.length = 0;
    handled.length = 0;
    logs.length = 0;
    process.env.CINDERPAW_INBOUND_PORT = "0";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === INCOMING) {
        sent.push(JSON.parse(new URLSearchParams(String(init?.body)).get("payload")!));
        return new Response('{"success":true}', { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    connector = new SynologyChatConnector();
    await connector.start(ctx());
  });

  afterEach(async () => {
    await connector.stop();
    globalThis.fetch = realFetch;
    delete process.env.CINDERPAW_INBOUND_PORT;
  });

  test("on the loopback default, start() says the NAS cannot reach it and names the setting", () => {
    expect(logs.some((l) => l.includes("CANNOT reach") && l.includes("CINDERPAW_INBOUND_HOST=0.0.0.0"))).toBe(true);
  });

  test("an allowlisted user is answered as a DM; a stranger is ignored", async () => {
    expect((await dispatch(msg("5", "hello"))).status).toBe(200);
    expect((await dispatch(msg("9", "hello"))).status).toBe(200);
    await settle();
    expect(handled).toEqual(["synology-chat:5|[user:5] hello"]);
    expect(sent).toEqual([{ text: "the answer", user_ids: [5] }]);
    expect(logs.some((l) => l.includes("non-allowlisted user 9"))).toBe(true);
  });

  test("a wrong token is 401 and reaches nothing", async () => {
    expect((await dispatch(msg("5", "hello", "p1", "nope"))).status).toBe(401);
    await settle();
    expect(handled).toEqual([]);
  });

  test("a redelivered post_id is handled once", async () => {
    await dispatch(msg("5", "again", "same"));
    await dispatch(msg("5", "again", "same"));
    await settle();
    expect(handled).toHaveLength(1);
  });
});
