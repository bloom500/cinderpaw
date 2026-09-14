/**
 * SMS on the inbound receiver, with a fake Twilio.
 *
 * The one thing LINE did not have: the signature covers the PUBLIC URL, so
 * the transport refuses to start without one, and a POST verified against a
 * different URL fails with a log line that names the URL it checked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { ChannelAskRouter } from "../src/core/ask-user-channel.ts";
import { dispatch, inboundRoutes } from "../src/transports/inbound.ts";
import { SmsConnector, smsSessionId, parseSmsSession, verifyTwilioSignature } from "../src/transports/sms.ts";
import type { ConnectorContext } from "../src/transports/registry.ts";

const TOKEN = "auth-token";
const PUBLIC = "https://example.test/connectors/sms";
const realFetch = globalThis.fetch;

function sign(url: string, params: URLSearchParams): string {
  const keys = [...new Set(params.keys())].sort();
  let data = url;
  for (const k of keys) for (const v of params.getAll(k)) data += k + v;
  return createHmac("sha1", TOKEN).update(data).digest("base64");
}

function text(from: string, body: string, sid = `SM${Math.random()}`): URLSearchParams {
  return new URLSearchParams({ From: from, To: "+15550000000", Body: body, MessageSid: sid });
}

function post(params: URLSearchParams, url = PUBLIC): Request {
  return new Request("http://x/connectors/sms", {
    method: "POST",
    body: params.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", "x-twilio-signature": sign(url, params) },
  });
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("session ids and the signature", () => {
  test("the phone is the session; `sms` stays segment 0", () => {
    expect(smsSessionId("+40700000000")).toBe("sms:+40700000000");
    expect(parseSmsSession("sms:+40700000000")).toEqual({ phone: "+40700000000" });
    expect(parseSmsSession("line:a:b")).toBeNull();
  });

  test("Twilio's scheme: URL + sorted params, HMAC-SHA1; a different URL fails", () => {
    const p = text("+1", "hi", "SM1");
    expect(verifyTwilioSignature(TOKEN, PUBLIC, p, sign(PUBLIC, p))).toBe(true);
    expect(verifyTwilioSignature(TOKEN, PUBLIC, p, sign("https://other.test/connectors/sms", p))).toBe(false);
    expect(verifyTwilioSignature(TOKEN, PUBLIC, p, null)).toBe(false);
  });
});

describe("a Twilio webhook, end to end", () => {
  const sent: Array<{ to: string; body: string }> = [];
  const handled: string[] = [];
  const logs: string[] = [];
  let connector: SmsConnector;

  const ctxWith = (overrides: Partial<ConnectorContext["row"]> & { url?: string }): ConnectorContext => ({
    row: { id: "sms", enabled: true, allowlist: ["+40700000001"], metadata: { TWILIO_FROM_NUMBER: "+15550000000", TWILIO_WEBHOOK_URL: overrides.url ?? PUBLIC }, ...overrides },
    secrets: { TWILIO_ACCOUNT_SID: "ACx", TWILIO_AUTH_TOKEN: TOKEN },
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

  beforeEach(() => {
    sent.length = 0;
    handled.length = 0;
    logs.length = 0;
    process.env.CINDERPAW_INBOUND_PORT = "0";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/Accounts/ACx.json")) return new Response("{}", { status: 200 });
      if (url.endsWith("/Messages.json")) {
        const b = new URLSearchParams(String(init?.body));
        sent.push({ to: b.get("To")!, body: b.get("Body")! });
        return new Response("{}", { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    connector = new SmsConnector();
  });

  afterEach(async () => {
    await connector.stop();
    globalThis.fetch = realFetch;
    delete process.env.CINDERPAW_INBOUND_PORT;
  });

  test("refuses to start without the public URL, and says what to type", async () => {
    await expect(connector.start(ctxWith({ url: "" }))).rejects.toThrow(/TWILIO_WEBHOOK_URL.*\/connectors\/sms/);
    expect(inboundRoutes()).toEqual([]);
  });

  test("an allowlisted phone is answered by a billed message; a stranger is ignored", async () => {
    await connector.start(ctxWith({}));
    const res = await dispatch(post(text("+40700000001", "hello")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/xml");
    await dispatch(post(text("+40700000009", "hello")));
    await settle();
    expect(handled).toEqual(["sms:+40700000001|[user:+40700000001] hello"]);
    expect(sent).toEqual([{ to: "+40700000001", body: "the answer" }]);
    expect(logs.some((l) => l.includes("non-allowlisted +40700000009"))).toBe(true);
  });

  test("signed for a different public URL: 401, and the log names the URL it checked", async () => {
    await connector.start(ctxWith({}));
    const res = await dispatch(post(text("+40700000001", "hello"), "https://other.test/connectors/sms"));
    expect(res.status).toBe(401);
    await settle();
    expect(handled).toEqual([]);
    expect(logs.some((l) => l.includes(`checked against ${PUBLIC}`))).toBe(true);
  });

  test("a retried MessageSid is handled once", async () => {
    await connector.start(ctxWith({}));
    const p = text("+40700000001", "again", "SMsame");
    await dispatch(post(p));
    await dispatch(post(p));
    await settle();
    expect(handled).toHaveLength(1);
  });
});
