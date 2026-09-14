/**
 * Google Chat on the inbound receiver, with a fake Google.
 *
 * The proof is a signed token, so the test mints its own RSA pair, plays
 * Google's certificate endpoint and token endpoint, and checks each of the
 * four things the verifier looks at: signature, issuer, audience, expiry.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { ChannelAskRouter } from "../src/core/ask-user-channel.ts";
import { dispatch } from "../src/transports/inbound.ts";
import {
  GoogleChatConnector,
  decodeJwt,
  googleChatSessionId,
  parseGoogleChatSession,
  serviceAccountAssertion,
  verifyGoogleChatJwt,
} from "../src/transports/googlechat.ts";
import type { ConnectorContext } from "../src/transports/registry.ts";

const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
const GOOGLE_PEM = google.publicKey.export({ type: "spki", format: "pem" }) as string;
const CERTS = { kid1: GOOGLE_PEM };
const sa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA_JSON = JSON.stringify({
  client_email: "bot@proj.iam.gserviceaccount.com",
  private_key: sa.privateKey.export({ type: "pkcs8", format: "pem" }),
});
const PROJECT = "123456789";
const realFetch = globalThis.fetch;

function mint(claims: Record<string, unknown>, kid = "kid1", key = google.privateKey): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signed = `${b({ alg: "RS256", typ: "JWT", kid })}.${b(claims)}`;
  const s = createSign("RSA-SHA256");
  s.update(signed);
  return `${signed}.${s.sign(key).toString("base64url")}`;
}
const good = (over: Record<string, unknown> = {}, kid = "kid1") =>
  mint({ iss: "chat@system.gserviceaccount.com", aud: PROJECT, exp: Math.floor(Date.now() / 1000) + 300, ...over }, kid);

function event(userId: string, text: string, name = `spaces/S/messages/${Math.random()}`, spaceType = "DM"): string {
  return JSON.stringify({
    type: "MESSAGE",
    message: { name, text, argumentText: text, sender: { name: userId, type: "HUMAN", email: "d@example.com" }, space: { name: "spaces/S", type: spaceType } },
  });
}
function post(body: string, token = good()): Request {
  return new Request("http://x/connectors/googlechat", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
}
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("the bearer token, check by check", () => {
  test("a good token passes", () => {
    expect(verifyGoogleChatJwt(good(), CERTS, PROJECT)).toBeNull();
  });
  test("each failure is named", () => {
    expect(verifyGoogleChatJwt("nope", CERTS, PROJECT)).toBe("not a JWT");
    expect(verifyGoogleChatJwt(good({}, "kid9"), CERTS, PROJECT)).toMatch(/unknown kid/);
    expect(verifyGoogleChatJwt(mint({ iss: "chat@system.gserviceaccount.com", aud: PROJECT, exp: 9e9 }, "kid1", sa.privateKey), CERTS, PROJECT)).toBe("signature mismatch");
    expect(verifyGoogleChatJwt(good({ iss: "someone@else" }), CERTS, PROJECT)).toMatch(/^issuer/);
    expect(verifyGoogleChatJwt(good({ aud: "999" }), CERTS, PROJECT)).toMatch(/^audience 999/);
    expect(verifyGoogleChatJwt(good({ exp: 1 }), CERTS, PROJECT)).toBe("expired");
  });
  test("the service-account assertion is RS256-signed with the pasted key", () => {
    const jwt = decodeJwt(serviceAccountAssertion(JSON.parse(SA_JSON)))!;
    expect(jwt.payload.iss).toBe("bot@proj.iam.gserviceaccount.com");
    expect(jwt.payload.scope).toBe("https://www.googleapis.com/auth/chat.bot");
    expect(cryptoVerify("RSA-SHA256", Buffer.from(jwt.signed), sa.publicKey, jwt.signature)).toBe(true);
  });
  test("session ids keep the slash in spaces/X and users/Y", () => {
    expect(googleChatSessionId("spaces/S", "users/1")).toBe("googlechat:spaces/S:users/1");
    expect(parseGoogleChatSession("googlechat:spaces/S:users/1")).toEqual({ space: "spaces/S", userId: "users/1" });
  });
});

describe("a Chat event, end to end", () => {
  const sent: Array<{ url: string; text: string }> = [];
  const handled: string[] = [];
  const logs: string[] = [];
  let connector: GoogleChatConnector;
  let tokenCalls = 0;

  const ctx = (over: Partial<ConnectorContext["row"]> = {}): ConnectorContext => ({
    row: { id: "googlechat", enabled: true, allowlist: ["users/1"], metadata: { GOOGLE_CHAT_PROJECT_NUMBER: PROJECT }, ...over },
    secrets: { GOOGLE_CHAT_SERVICE_ACCOUNT: SA_JSON },
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
    tokenCalls = 0;
    process.env.CINDERPAW_INBOUND_PORT = "0";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/metadata/x509/")) return new Response(JSON.stringify(CERTS), { status: 200 });
      if (url === "https://oauth2.googleapis.com/token") {
        tokenCalls++;
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      }
      if (url.startsWith("https://chat.googleapis.com/v1/spaces/")) {
        sent.push({ url, text: (JSON.parse(String(init?.body)) as { text: string }).text });
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    connector = new GoogleChatConnector();
  });

  afterEach(async () => {
    await connector.stop();
    globalThis.fetch = realFetch;
    delete process.env.CINDERPAW_INBOUND_PORT;
  });

  test("a project ID with letters is refused with the reason", async () => {
    await expect(connector.start(ctx({ metadata: { GOOGLE_CHAT_PROJECT_NUMBER: "my-project" } }))).rejects.toThrow(/digits only/);
  });

  test("a DM from an allowlisted user is answered through the Chat API with one token", async () => {
    await connector.start(ctx());
    expect(tokenCalls).toBe(1);
    expect((await dispatch(post(event("users/1", "hello")))).status).toBe(200);
    await settle();
    expect(handled).toEqual(["googlechat:spaces/S:users/1|[user:users/1] hello"]);
    expect(sent).toEqual([{ url: "https://chat.googleapis.com/v1/spaces/S/messages", text: "the answer" }]);
    expect(tokenCalls).toBe(1);
  });

  test("a bad token is 401 with the check that failed in the log", async () => {
    await connector.start(ctx());
    expect((await dispatch(post(event("users/1", "hello"), good({ aud: "999" })))).status).toBe(401);
    await settle();
    expect(handled).toEqual([]);
    expect(logs.some((l) => l.includes("rejected a POST (audience 999"))).toBe(true);
  });

  test("a room is answered only when named; a stranger in a DM is ignored", async () => {
    await connector.start(ctx());
    await dispatch(post(event("users/1", "in a room", "spaces/S/messages/r", "ROOM")));
    await dispatch(post(event("users/2", "stranger")));
    await settle();
    expect(handled).toEqual([]);
    expect(logs.some((l) => l.includes("non-allowlisted users/2"))).toBe(true);
  });

  test("the allowlist also takes the sender's email, in any case", async () => {
    await connector.start(ctx({ allowlist: ["D@Example.com"] }));
    await dispatch(post(event("users/7", "by email")));
    await settle();
    expect(handled).toHaveLength(1);
  });
});
