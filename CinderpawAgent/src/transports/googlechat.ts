/**
 * Google Chat — the fourth connector on the inbound receiver, and the first
 * whose proof is a signed token rather than a shared secret.
 *
 * Chat POSTs each event with `Authorization: Bearer <JWT>` signed by Google
 * (issuer `chat@system.gserviceaccount.com`, audience = the Cloud project
 * NUMBER the app lives in). We verify RS256 against Google's published X.509
 * certificates, fetched once and re-fetched when a `kid` is unknown, and
 * check issuer, audience and expiry. Only then is the body parsed.
 *
 * Replies go through the Chat API with a service-account token: the JSON
 * key the person pasted signs a JWT that `oauth2.googleapis.com` exchanges
 * for an hour's access token. Answering in the webhook response would be
 * simpler and is what the docs show first, but Chat waits 30 seconds and an
 * agent turn does not fit; so 200 with an empty body, then a POST to the
 * space's messages endpoint.
 *
 * Setup the person does in Google Cloud, and the card says so: enable the
 * Chat API, create the app with "HTTP endpoint URL" = their public address
 * + /connectors/googlechat, create a service account and paste its JSON key.
 *
 * ponytail: text only, no cards, no slash commands, no threads (a reply lands
 * in the space, not under the message).
 */

import { createPublicKey, createSign, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import {
  connectorErrorMessage,
  mimeForName,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief, formatForChat } from "./chat-format.ts";
import { inboundAddress, inboundPath, serveInbound, type InboundRequest } from "./inbound.ts";
import {
  registerTransport,
  type ConnectorContext,
  type LiveConnector,
  type OutboundFile,
} from "./registry.ts";

const CHAT_MAX = 4000;
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
const CERTS_URL = `https://www.googleapis.com/service_accounts/v1/metadata/x509/${CHAT_ISSUER}`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHAT_API = "https://chat.googleapis.com/v1";
/** Uploads go to the media prefix; the same path under /v1 answers 404. */
const CHAT_UPLOAD_API = "https://chat.googleapis.com/upload/v1";

export function googleChatSessionId(space: string, userId: string): string {
  // `spaces/AAAA` and `users/123`: the slash is kept, the colon is ours.
  return `googlechat:${space}:${userId}`;
}

export function parseGoogleChatSession(sessionId: string): { space: string; userId: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[0] !== "googlechat" || !parts[1] || !parts[2]) return null;
  return { space: parts[1], userId: parts[2] };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** A JWT's three parts, decoded but NOT yet trusted. */
export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signed: string; signature: Buffer } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")),
      payload: JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")),
      signed: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2]!, "base64url"),
    };
  } catch {
    return null;
  }
}

/**
 * Verify a Chat bearer token against Google's certs. `certs` maps kid → PEM
 * certificate; `now` is injectable for the test. Returns why it failed, or
 * null when it is good, so the log can say which of the four checks missed.
 */
export function verifyGoogleChatJwt(
  token: string,
  certs: Record<string, string>,
  audience: string,
  now = Date.now() / 1000,
): string | null {
  const jwt = decodeJwt(token);
  if (!jwt) return "not a JWT";
  if (jwt.header.alg !== "RS256") return `alg ${String(jwt.header.alg)}`;
  const pem = certs[String(jwt.header.kid)];
  if (!pem) return `unknown kid ${String(jwt.header.kid)}`;
  let ok = false;
  try {
    ok = cryptoVerify("RSA-SHA256", Buffer.from(jwt.signed), createPublicKey(pem), jwt.signature);
  } catch (e) {
    return `bad certificate: ${String(e)}`;
  }
  if (!ok) return "signature mismatch";
  if (jwt.payload.iss !== CHAT_ISSUER) return `issuer ${String(jwt.payload.iss)}`;
  const aud = String(jwt.payload.aud ?? "");
  const a = Buffer.from(aud);
  const b = Buffer.from(audience);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return `audience ${aud} (expected the project number ${audience})`;
  if (typeof jwt.payload.exp !== "number" || jwt.payload.exp < now) return "expired";
  return null;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/** Sign the service-account assertion that buys a Chat API access token. */
export function serviceAccountAssertion(sa: ServiceAccount, now = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/chat.bot",
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
}

interface ChatMessage {
  name?: string;
  text?: string;
  argumentText?: string;
  sender?: { name?: string; type?: string; email?: string };
  space?: { name?: string; type?: string; spaceType?: string };
}
interface ChatEvent {
  type?: string;
  message?: ChatMessage;
  /** The newer event format nests the same message here. */
  chat?: { messagePayload?: { message?: ChatMessage } };
}

export class GoogleChatConnector implements LiveConnector {
  #sa: ServiceAccount | null = null;
  #project = "";
  #certs: Record<string, string> = {};
  #token: { value: string; exp: number } | null = null;
  #ctx: ConnectorContext | null = null;
  #live = false;
  #error: string | undefined;
  #allow = new Set<string>();
  #spaces = new Set<string>();
  #unserve: (() => Promise<void>) | null = null;
  #seen = new Set<string>();

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    const field = (k: string) => (ctx.row.metadata?.[k] ?? ctx.secrets[k] ?? "").trim();
    this.#project = field("GOOGLE_CHAT_PROJECT_NUMBER");
    const raw = field("GOOGLE_CHAT_SERVICE_ACCOUNT");
    if (!raw || !this.#project) {
      throw new Error(
        "googlechat: enabled but missing the service account JSON or the project number " +
          "(Cloud console: IAM → Service accounts → Keys → JSON; the project number is on the dashboard, digits only)",
      );
    }
    if (!/^\d+$/.test(this.#project)) {
      throw new Error(`googlechat: the project number must be digits only (got ${JSON.stringify(this.#project)}); the project ID with letters is a different thing`);
    }
    try {
      const sa = JSON.parse(raw) as Partial<ServiceAccount>;
      if (!sa.client_email || !sa.private_key) throw new Error("no client_email/private_key");
      this.#sa = sa as ServiceAccount;
    } catch (e) {
      throw new Error(`googlechat: the service account field is not a service-account JSON key (${String(e)})`);
    }

    // Both remote dependencies before a port opens: the certs prove Google can
    // reach us with something we can check, the token proves the key works.
    this.#certs = await this.#fetchCerts();
    await this.#accessToken();

    // Lowercased on both sides: an email typed with a capital is the same person.
    this.#allow = new Set((ctx.row.allowlist ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean));
    this.#spaces = new Set((ctx.row.channels ?? []).map((s) => s.trim()).filter(Boolean));
    this.#unserve = await serveInbound("googlechat", (req) => this.#onRequest(req), ctx.log);
    const { host, port } = inboundAddress();
    ctx.log(
      `googlechat: connected as ${this.#sa.client_email} (${
        this.#allow.size === 0
          ? "0 allowed — NOBODY CAN REACH IT: the allowlist is empty, so every message is ignored. " +
            "Add Google account emails, or user ids like users/123, to the allowlist to make it answer."
          : `${this.#allow.size} allowed`
      }). HTTP endpoint URL for the Chat app: https://<your public host>${inboundPath("googlechat")} → http://${host}:${port}${inboundPath("googlechat")}`,
    );

    ctx.askRouter.registerSender("googlechat", (sessionId, text) => this.send(sessionId, text));
    this.#live = true;
    this.#error = undefined;
  }

  async stop(): Promise<void> {
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("googlechat");
    await this.#unserve?.();
    this.#unserve = null;
  }

  health(): ConnectorHealth {
    return this.#live
      ? { live: true }
      : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseGoogleChatSession(sessionId);
    if (!target) return;
    const token = await this.#accessToken();
    for (const part of formatForChat(text, CHAT_MAX)) {
      const res = await fetch(`${CHAT_API}/${target.space}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: part }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`googlechat: the Chat API answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  /**
   * A file into the space behind `sessionId`.
   *
   * Google Chat wants the bytes on a different host prefix than the messages
   * (`/upload/v1/...`, not `/v1/...`), and answers with a reference token
   * rather than a URL; the message that follows carries that token in
   * `attachment`. The upload is `uploadType=media`, the raw body, which is
   * the one form that needs no multipart boundary to get right.
   *
   * A Chat app can only attach to a space it is a member of, and the API says
   * so with 403 rather than with silence, so that answer is passed through.
   */
  async sendFile(sessionId: string, file: OutboundFile): Promise<void> {
    const target = parseGoogleChatSession(sessionId);
    if (!target) throw new Error("Google Chat: that conversation is not a space I can post in.");
    const token = await this.#accessToken();

    const up = await fetch(
      `${CHAT_UPLOAD_API}/${target.space}/attachments:upload?uploadType=media`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": mimeForName(file.name) },
        body: Buffer.from(file.data),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!up.ok) {
      throw new Error(
        `googlechat: the upload was refused (HTTP ${up.status}): ${(await up.text()).slice(0, 200)}`,
      );
    }
    const ref = ((await up.json()) as { attachmentDataRef?: { resourceName?: string } })
      .attachmentDataRef;
    if (!ref?.resourceName) {
      throw new Error("googlechat: the upload succeeded but returned no attachment reference.");
    }

    const res = await fetch(`${CHAT_API}/${target.space}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: file.caption.slice(0, CHAT_MAX),
        attachment: [{ name: file.name, attachmentDataRef: ref }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(
        `googlechat: the file was uploaded but the message was refused (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`,
      );
    }
  }

  async #fetchCerts(): Promise<Record<string, string>> {
    const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`googlechat: cannot fetch Google's signing certificates (HTTP ${res.status})`);
    return (await res.json()) as Record<string, string>;
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.exp > Date.now() / 1000 + 60) return this.#token.value;
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: serviceAccountAssertion(this.#sa!),
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(
        res.status === 400 || res.status === 401
          ? "googlechat: Google rejected the service account key — it may be deleted or from another project; create a new JSON key and paste it again"
          : `googlechat: the token endpoint answered HTTP ${res.status}`,
      );
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.#token = { value: body.access_token, exp: Date.now() / 1000 + body.expires_in };
    return body.access_token;
  }

  async #onRequest(req: InboundRequest): Promise<Response> {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    let why = verifyGoogleChatJwt(token, this.#certs, this.#project);
    // Google rotates its certificates; an unknown kid is the one failure
    // worth a single refresh before it is a refusal.
    if (why?.startsWith("unknown kid")) {
      try {
        this.#certs = await this.#fetchCerts();
        why = verifyGoogleChatJwt(token, this.#certs, this.#project);
      } catch (e) {
        why = `certificate refresh failed: ${String(e)}`;
      }
    }
    if (why) {
      this.#ctx?.log(`googlechat: rejected a POST (${why})`);
      return new Response("unauthorized", { status: 401 });
    }
    let ev: ChatEvent;
    try {
      ev = JSON.parse(Buffer.from(req.body).toString("utf8")) as ChatEvent;
    } catch {
      return new Response("bad json", { status: 400 });
    }
    void this.#onEvent(ev);
    // An empty JSON object is "no synchronous reply"; the answer comes by API.
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }

  async #onEvent(ev: ChatEvent): Promise<void> {
    const msg = ev.message ?? ev.chat?.messagePayload?.message;
    if (!msg) return;
    if (ev.type && ev.type !== "MESSAGE") return;
    if (msg.sender?.type === "BOT") return;
    // `argumentText` is the text with the @mention stripped; in a DM it is
    // the whole message. Fall back to `text` for the newer event format.
    const text = (msg.argumentText ?? msg.text ?? "").trim();
    const userId = msg.sender?.name;
    const space = msg.space?.name;
    if (!text || !userId || !space) return;

    const key = msg.name ?? "";
    if (key) {
      if (this.#seen.has(key)) return;
      this.#seen.add(key);
      if (this.#seen.size > 2000) this.#seen.delete(this.#seen.values().next().value!);
    }

    const isDm = msg.space?.type === "DM" || msg.space?.spaceType === "DIRECT_MESSAGE";
    if (!isDm && (this.#spaces.size === 0 || !this.#spaces.has(space))) return;

    const ctx = this.#ctx;
    if (!ctx) return;
    const email = msg.sender?.email?.toLowerCase() ?? "";
    ctx.onSender?.(userId.toLowerCase(), userId.toLowerCase());
    if (!this.#allow.has(userId.toLowerCase()) && !(email && this.#allow.has(email))) {
      ctx.log(`googlechat: ignored a message from non-allowlisted ${userId}${email ? ` (${email})` : ""}`);
      return;
    }
    const sessionId = googleChatSessionId(space, userId);
    try {
      const command = await runChatCommand(ctx.agent, sessionId, text);
      if (command) {
        await this.send(sessionId, command);
        return;
      }
      if (ctx.askRouter.handleInbound(sessionId, text)) return;

      if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
      ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("Google Chat"));

      const { reply } = await runAgent(ctx.agent, sessionId, `[user:${userId}] ${text}`, `googlechat-${key || Date.now()}`);
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`googlechat: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e)).catch(() => {});
    }
  }
}

registerTransport("googlechat", () => new GoogleChatConnector());
