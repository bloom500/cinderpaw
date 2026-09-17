/**
 * Teams on the inbound receiver, with a fake Bot Framework.
 *
 * New here versus Google Chat: the keys arrive as JWKs, the token names the
 * service URL replies may go to, and Teams ids carry colons so the session id
 * has to encode them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSign, generateKeyPairSync } from "node:crypto";
import { ChannelAskRouter } from "../src/core/ask-user-channel.ts";
import { dispatch } from "../src/transports/inbound.ts";
import { TeamsConnector, parseTeamsSession, teamsSessionId, verifyTeamsJwt, type Jwk } from "../src/transports/msteams.ts";
import type { ConnectorContext } from "../src/transports/registry.ts";

const ms = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...(ms.publicKey.export({ format: "jwk" }) as { kty: string; n: string; e: string }), kid: "k1" } as Jwk;
const APP = "app-id-guid";
const SERVICE = "https://smba.trafficmanager.net/emea/";
const CONV = "19:abc@thread.tacv2;messageid=1";
const realFetch = globalThis.fetch;

function mint(claims: Record<string, unknown>, kid = "k1"): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signed = `${b({ alg: "RS256", typ: "JWT", kid })}.${b(claims)}`;
  const s = createSign("RSA-SHA256");
  s.update(signed);
  return `${signed}.${s.sign(ms.privateKey).toString("base64url")}`;
}
const good = (over: Record<string, unknown> = {}) =>
  mint({ iss: "https://api.botframework.com", aud: APP, serviceurl: SERVICE, exp: Math.floor(Date.now() / 1000) + 300, ...over });

function activity(userId: string, text: string, id = `${Math.random()}`, conversationType = "personal"): string {
  return JSON.stringify({
    type: "message",
    id,
    text,
    serviceUrl: SERVICE,
    from: { id: userId, name: "Darius", aadObjectId: "aad-1" },
    conversation: { id: CONV, conversationType },
  });
}
function post(body: string, token = good()): Request {
  return new Request("http://x/connectors/msteams", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
}
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("the token and the session id", () => {
  test("a good token passes; each failure is named", () => {
    expect(verifyTeamsJwt(good(), [JWK], APP, SERVICE)).toBeNull();
    expect(verifyTeamsJwt(good({ aud: "other" }), [JWK], APP, SERVICE)).toMatch(/^audience/);
    expect(verifyTeamsJwt(good({ iss: "x" }), [JWK], APP, SERVICE)).toMatch(/^issuer/);
    expect(verifyTeamsJwt(good({ exp: 1 }), [JWK], APP, SERVICE)).toBe("expired");
    expect(verifyTeamsJwt(good(), [JWK], APP, "https://elsewhere.example/")).toMatch(/^serviceurl/);
    expect(verifyTeamsJwt(good(), [], APP, SERVICE)).toMatch(/^unknown kid/);
  });
  test("ids with colons survive the session id round trip", () => {
    const sid = teamsSessionId(CONV, "29:1user");
    expect(sid.split(":")[0]).toBe("msteams");
    expect(parseTeamsSession(sid)).toEqual({ conversationId: CONV, userId: "29:1user" });
  });
});

describe("an activity, end to end", () => {
  const sent: Array<{ url: string; text: string }> = [];
  const handled: string[] = [];
  const logs: string[] = [];
  let connector: TeamsConnector;
  let authority = "";

  const ctx = (over: Partial<ConnectorContext["row"]> = {}): ConnectorContext => ({
    row: { id: "msteams", enabled: true, allowlist: ["29:1user"], metadata: { MSTEAMS_APP_ID: APP }, ...over },
    secrets: { MSTEAMS_APP_PASSWORD: "pw" },
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
      if (url.endsWith("/openidconfiguration")) return new Response(JSON.stringify({ jwks_uri: "https://login.botframework.com/v1/.well-known/keys" }), { status: 200 });
      if (url.endsWith("/keys")) return new Response(JSON.stringify({ keys: [JWK] }), { status: 200 });
      if (url.includes("login.microsoftonline.com")) {
        authority = url.split("/")[3]!;
        return new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 });
      }
      if (url.startsWith(SERVICE)) {
        sent.push({ url, text: (JSON.parse(String(init?.body)) as { text: string }).text });
        return new Response("{}", { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    connector = new TeamsConnector();
  });

  afterEach(async () => {
    await connector.stop();
    globalThis.fetch = realFetch;
    delete process.env.CINDERPAW_INBOUND_PORT;
  });

  test("a personal chat from an allowlisted user is answered at the activity's serviceUrl", async () => {
    await connector.start(ctx());
    expect(authority).toBe("botframework.com");
    expect((await dispatch(post(activity("29:1user", "hello")))).status).toBe(200);
    await settle();
    expect(handled).toEqual([`${teamsSessionId(CONV, "29:1user")}|[user:29:1user] hello`]);
    expect(sent).toEqual([{ url: `${SERVICE}v3/conversations/${encodeURIComponent(CONV)}/activities`, text: "the answer" }]);
  });

  test("a single-tenant app authenticates against its tenant", async () => {
    await connector.start(ctx({ metadata: { MSTEAMS_APP_ID: APP, MSTEAMS_TENANT_ID: "tenant-guid" } }));
    expect(authority).toBe("tenant-guid");
  });

  test("a token for another serviceUrl is 401: replies cannot be steered", async () => {
    await connector.start(ctx());
    expect((await dispatch(post(activity("29:1user", "hello"), good({ serviceurl: "https://evil.example/" })))).status).toBe(401);
    await settle();
    expect(handled).toEqual([]);
    expect(logs.some((l) => l.includes("rejected a POST (serviceurl"))).toBe(true);
  });

  test("a channel is answered only when named, the @mention is stripped, and a stranger is named in the log", async () => {
    await connector.start(ctx({ allowlist: ["aad-1"], channels: [CONV] }));
    await dispatch(post(activity("29:1user", "<at>Cinderpaw</at> in a channel", "c1", "channel")));
    await settle();
    expect(handled).toEqual([`${teamsSessionId(CONV, "29:1user")}|[user:29:1user] in a channel`]);
    await connector.stop();
    connector = new TeamsConnector();
    await connector.start(ctx({ allowlist: ["nobody"] }));
    await dispatch(post(activity("29:1user", "hi")));
    await settle();
    expect(logs.some((l) => l.includes("non-allowlisted 29:1user (aadObjectId aad-1)"))).toBe(true);
  });
});
