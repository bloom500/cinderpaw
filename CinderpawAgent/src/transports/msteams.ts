/**
 * Microsoft Teams — the last of the five on the inbound receiver.
 *
 * Teams reaches a bot through the Bot Framework: each activity is POSTed to
 * the messaging endpoint with `Authorization: Bearer <JWT>` signed by
 * Microsoft (issuer `https://api.botframework.com`, audience = the app id).
 * Keys are JWKs at the framework's OpenID metadata; we verify RS256 with
 * `node:crypto`, then issuer, audience, expiry, and that the token's
 * `serviceurl` claim matches the activity's, which is the check that stops a
 * replayed token from steering replies elsewhere.
 *
 * Replies go back to the activity's `serviceUrl` with a token from Entra
 * (client credentials: app id + password). Single-tenant apps hand us their
 * tenant id; blank means the multi-tenant `botframework.com` authority.
 *
 * The person still does the Azure side, and the card says so: register a
 * bot (Azure Bot or the Developer Portal), set the messaging endpoint to
 * their public address + /connectors/msteams, and have an admin install the
 * app. That is the real cost of this connector, not the code.
 *
 * ponytail: text only, no cards, no files, no proactive messages to people
 * who have not written first.
 */

import { createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import {
  connectorErrorMessage,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief, formatForChat } from "./chat-format.ts";
import { decodeJwt } from "./googlechat.ts";
import { inboundAddress, inboundPath, serveInbound, type InboundRequest } from "./inbound.ts";
import { registerTransport, type ConnectorContext, type LiveConnector } from "./registry.ts";

const TEAMS_MAX = 4000;
const OPENID_URL = "https://login.botframework.com/v1/.well-known/openidconfiguration";
const ISSUER = "https://api.botframework.com";

/** Teams ids carry colons (`29:1abc`, `19:xyz@thread.tacv2`), so both halves
 *  are base64url in the session id and the router's prefix split stays safe. */
export function teamsSessionId(conversationId: string, userId: string): string {
  const b = (s: string) => Buffer.from(s).toString("base64url");
  return `msteams:${b(conversationId)}:${b(userId)}`;
}

export function parseTeamsSession(sessionId: string): { conversationId: string; userId: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[0] !== "msteams" || !parts[1] || !parts[2]) return null;
  const d = (s: string) => Buffer.from(s, "base64url").toString("utf8");
  return { conversationId: d(parts[1]), userId: d(parts[2]) };
}

export interface Jwk {
  kid: string;
  kty: string;
  n?: string;
  e?: string;
  /** Bot Framework keys list the service URLs they are valid for. */
  endorsements?: string[];
}

/**
 * Verify a Bot Framework bearer token. Returns why it failed, or null. The
 * `serviceUrl` is the one in the activity body; the token must name it.
 */
export function verifyTeamsJwt(
  token: string,
  keys: Jwk[],
  appId: string,
  serviceUrl: string,
  now = Date.now() / 1000,
): string | null {
  const jwt = decodeJwt(token);
  if (!jwt) return "not a JWT";
  if (jwt.header.alg !== "RS256") return `alg ${String(jwt.header.alg)}`;
  const key = keys.find((k) => k.kid === jwt.header.kid && k.kty === "RSA");
  if (!key) return `unknown kid ${String(jwt.header.kid)}`;
  let ok = false;
  try {
    ok = cryptoVerify("RSA-SHA256", Buffer.from(jwt.signed), createPublicKey({ key: key as never, format: "jwk" }), jwt.signature);
  } catch (e) {
    return `bad key: ${String(e)}`;
  }
  if (!ok) return "signature mismatch";
  if (jwt.payload.iss !== ISSUER) return `issuer ${String(jwt.payload.iss)}`;
  const aud = String(jwt.payload.aud ?? "");
  const a = Buffer.from(aud);
  const b = Buffer.from(appId);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return `audience ${aud} (expected the app id)`;
  if (typeof jwt.payload.exp !== "number" || jwt.payload.exp < now) return "expired";
  const claimed = String(jwt.payload.serviceurl ?? "").replace(/\/+$/, "");
  if (claimed && claimed !== serviceUrl.replace(/\/+$/, "")) return `serviceurl ${claimed} does not match the activity's ${serviceUrl}`;
  return null;
}

interface Activity {
  type?: string;
  id?: string;
  text?: string;
  serviceUrl?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string };
  conversation?: { id?: string; conversationType?: string };
}

export class TeamsConnector implements LiveConnector {
  #appId = "";
  #password = "";
  #tenant = "";
  #keys: Jwk[] = [];
  #token: { value: string; exp: number } | null = null;
  #ctx: ConnectorContext | null = null;
  #live = false;
  #error: string | undefined;
  #allow = new Set<string>();
  #channels = new Set<string>();
  #unserve: (() => Promise<void>) | null = null;
  #seen = new Set<string>();
  /** serviceUrl per conversation, learned from the activity that started it. */
  #serviceUrls = new Map<string, string>();

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    const field = (k: string) => (ctx.row.metadata?.[k] ?? ctx.secrets[k] ?? "").trim();
    this.#appId = field("MSTEAMS_APP_ID");
    this.#password = field("MSTEAMS_APP_PASSWORD");
    this.#tenant = field("MSTEAMS_TENANT_ID");
    if (!this.#appId || !this.#password) {
      throw new Error(
        "msteams: enabled but missing the app id or the app password " +
          "(Azure portal → your bot → Configuration: Microsoft App ID; Manage password → New client secret)",
      );
    }

    this.#keys = await this.#fetchKeys();
    await this.#accessToken();

    this.#allow = new Set((ctx.row.allowlist ?? []).map((s) => s.trim()).filter(Boolean));
    this.#channels = new Set((ctx.row.channels ?? []).map((s) => s.trim()).filter(Boolean));
    this.#unserve = await serveInbound("msteams", (req) => this.#onRequest(req), ctx.log);
    const { host, port } = inboundAddress();
    ctx.log(
      `msteams: connected as app ${this.#appId} (${
        this.#allow.size === 0
          ? "0 allowed — NOBODY CAN REACH IT: the allowlist is empty, so every message is ignored. " +
            "Add Teams user ids (the aadObjectId or 29:... id printed when a message is ignored) to the allowlist."
          : `${this.#allow.size} allowed`
      }). Messaging endpoint for the bot: https://<your public host>${inboundPath("msteams")} → http://${host}:${port}${inboundPath("msteams")}`,
    );

    ctx.askRouter.registerSender("msteams", (sessionId, text) => this.send(sessionId, text));
    this.#live = true;
    this.#error = undefined;
  }

  async stop(): Promise<void> {
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("msteams");
    await this.#unserve?.();
    this.#unserve = null;
  }

  health(): ConnectorHealth {
    return this.#live
      ? { live: true }
      : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseTeamsSession(sessionId);
    if (!target) return;
    const serviceUrl = this.#serviceUrls.get(target.conversationId);
    if (!serviceUrl) throw new Error("msteams: no service URL for this conversation yet (nobody has written in it since start)");
    const token = await this.#accessToken();
    for (const part of formatForChat(text, TEAMS_MAX)) {
      const res = await fetch(`${serviceUrl.replace(/\/+$/, "")}/v3/conversations/${encodeURIComponent(target.conversationId)}/activities`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "message", text: part }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`msteams: the Bot Framework answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  async #fetchKeys(): Promise<Jwk[]> {
    const meta = await fetch(OPENID_URL, { signal: AbortSignal.timeout(15_000) });
    if (!meta.ok) throw new Error(`msteams: cannot fetch the Bot Framework OpenID metadata (HTTP ${meta.status})`);
    const { jwks_uri } = (await meta.json()) as { jwks_uri: string };
    const jwks = await fetch(jwks_uri, { signal: AbortSignal.timeout(15_000) });
    if (!jwks.ok) throw new Error(`msteams: cannot fetch the Bot Framework signing keys (HTTP ${jwks.status})`);
    return ((await jwks.json()) as { keys: Jwk[] }).keys;
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.exp > Date.now() / 1000 + 60) return this.#token.value;
    const authority = this.#tenant || "botframework.com";
    const res = await fetch(`https://login.microsoftonline.com/${authority}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.#appId,
        client_secret: this.#password,
        scope: "https://api.botframework.com/.default",
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(
        res.status === 400 || res.status === 401
          ? "msteams: Entra rejected the app id + password — the secret may have expired (they do, by default in 6 months); make a new one and paste it again"
          : `msteams: the token endpoint answered HTTP ${res.status}`,
      );
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.#token = { value: body.access_token, exp: Date.now() / 1000 + body.expires_in };
    return body.access_token;
  }

  async #onRequest(req: InboundRequest): Promise<Response> {
    let activity: Activity;
    try {
      activity = JSON.parse(Buffer.from(req.body).toString("utf8")) as Activity;
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const serviceUrl = activity.serviceUrl ?? "";
    let why = verifyTeamsJwt(token, this.#keys, this.#appId, serviceUrl);
    if (why?.startsWith("unknown kid")) {
      try {
        this.#keys = await this.#fetchKeys();
        why = verifyTeamsJwt(token, this.#keys, this.#appId, serviceUrl);
      } catch (e) {
        why = `key refresh failed: ${String(e)}`;
      }
    }
    if (why) {
      this.#ctx?.log(`msteams: rejected a POST (${why})`);
      return new Response("unauthorized", { status: 401 });
    }
    void this.#onActivity(activity);
    return new Response("", { status: 200 });
  }

  async #onActivity(a: Activity): Promise<void> {
    if (a.type !== "message") return;
    const conversationId = a.conversation?.id;
    const userId = a.from?.id;
    if (!conversationId || !userId || !a.serviceUrl) return;
    // Strip the @mention Teams puts in front of a channel message.
    const text = (a.text ?? "").replace(/<at>[^<]*<\/at>/g, "").trim();
    if (!text) return;

    if (a.id) {
      if (this.#seen.has(a.id)) return;
      this.#seen.add(a.id);
      if (this.#seen.size > 2000) this.#seen.delete(this.#seen.values().next().value!);
    }
    this.#serviceUrls.set(conversationId, a.serviceUrl);

    const personal = a.conversation?.conversationType === "personal";
    if (!personal && (this.#channels.size === 0 || !this.#channels.has(conversationId))) return;

    const ctx = this.#ctx;
    if (!ctx) return;
    const aad = a.from?.aadObjectId ?? "";
    if (!this.#allow.has(userId) && !(aad && this.#allow.has(aad))) {
      ctx.log(`msteams: ignored a message from non-allowlisted ${userId}${aad ? ` (aadObjectId ${aad})` : ""}`);
      return;
    }
    const sessionId = teamsSessionId(conversationId, userId);
    try {
      const command = await runChatCommand(ctx.agent, sessionId, text);
      if (command) {
        await this.send(sessionId, command);
        return;
      }
      if (ctx.askRouter.handleInbound(sessionId, text)) return;

      if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
      ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("Microsoft Teams"));

      const { reply } = await runAgent(ctx.agent, sessionId, `[user:${userId}] ${text}`, `msteams-${a.id ?? Date.now()}`);
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`msteams: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e)).catch(() => {});
    }
  }
}

registerTransport("msteams", () => new TeamsConnector());
