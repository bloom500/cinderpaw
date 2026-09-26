/**
 * LINE — the first connector on the inbound receiver.
 *
 * LINE's Messaging API has no pull path: it POSTs every event to a webhook
 * URL you register in the developers console, and it signs each body with
 * the channel secret (`x-line-signature` = base64 HMAC-SHA256 over the raw
 * bytes). So this transport is Telegram's shape with the poll loop replaced
 * by a route on `inbound.ts`, and one rule that Telegram never needed: the
 * signature is checked on the bytes as received, before anything is parsed.
 *
 * The public address is the user's (decision 2026-09-12): they point a
 * tunnel or proxy at the receiver and paste `https://<their host>/connectors/line`
 * into the console. Until they do, LINE's "Verify" button fails and the card
 * says why. No dependency: two endpoints, `bot/info` and `message/push`.
 *
 * Replies go by `push`, not `reply`: a reply token expires in about a minute
 * and an agent turn can take longer, so answering through the token would
 * lose every slow answer. Push costs a message quota unit on the free plan;
 * the card says so.
 *
 * ponytail: text both ways, no stickers, no images, no quick replies.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
  connectorErrorMessage,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief, formatForChat } from "./chat-format.ts";
import { inboundAddress, inboundPath, serveInbound, type InboundRequest } from "./inbound.ts";
import { registerTransport, type ConnectorContext, type LiveConnector } from "./registry.ts";

/** LINE rejects a text message over 5000 characters. */
const LINE_MAX = 4900;
const API = "https://api.line.me/v2/bot";

export function lineSessionId(to: string, userId: string): string {
  return `line:${to}:${userId}`;
}

export function parseLineSession(sessionId: string): { to: string; userId: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[0] !== "line") return null;
  return { to: parts[1]!, userId: parts[2]! };
}

/** Constant-time check of LINE's signature over the raw body. */
export function verifyLineSignature(secret: string, body: Uint8Array, header: string | null): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  let given: Buffer;
  try {
    given = Buffer.from(header, "base64");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface LineEvent {
  type: string;
  webhookEventId?: string;
  deliveryContext?: { isRedelivery?: boolean };
  source?: { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string };
  message?: { type: string; id: string; text?: string };
}

export class LineConnector implements LiveConnector {
  #token = "";
  #secret = "";
  #ctx: ConnectorContext | null = null;
  #live = false;
  #error: string | undefined;
  #allow = new Set<string>();
  #chats = new Set<string>();
  #unserve: (() => Promise<void>) | null = null;
  /**
   * LINE redelivers an event it did not get a 200 for, and a tunnel that
   * flaps can hand us the same POST twice. The event id is the dedup key;
   * bounded so a long-running process does not keep every id for ever.
   */
  #seen = new Set<string>();

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    this.#token = (ctx.secrets.LINE_CHANNEL_ACCESS_TOKEN ?? "").trim();
    this.#secret = (ctx.secrets.LINE_CHANNEL_SECRET ?? "").trim();
    if (!this.#token || !this.#secret) {
      throw new Error(
        "line: enabled but missing the channel access token or the channel secret " +
          "(both are on the Messaging API tab of your channel in the LINE Developers console)",
      );
    }

    // Validate the token before opening a port for it: a typo fails here
    // with a sentence rather than as a webhook that verifies and never answers.
    const info = await this.#api("GET", "/info");
    if (!info.ok) {
      throw new Error(
        info.status === 401
          ? "line: LINE rejected the channel access token — issue a new long-lived one in the console and paste it again"
          : `line: LINE answered HTTP ${info.status} to bot/info`,
      );
    }

    this.#allow = new Set((ctx.row.allowlist ?? []).map((s) => s.trim()).filter(Boolean));
    this.#chats = new Set((ctx.row.channels ?? []).map((s) => s.trim()).filter(Boolean));

    this.#unserve = await serveInbound("line", (req) => this.#onRequest(req), ctx.log);
    const { host, port } = inboundAddress();
    ctx.log(
      `line: connected (${
        this.#allow.size === 0
          ? "0 allowed — NOBODY CAN REACH IT: the allowlist is empty, so every message is ignored. " +
            "Add LINE user ids (they start with U) to the allowlist to make it answer."
          : `${this.#allow.size} allowed`
      }). Webhook URL for the console: https://<your public host>${inboundPath("line")} → http://${host}:${port}${inboundPath("line")}`,
    );

    ctx.askRouter.registerSender("line", (sessionId, text) => this.send(sessionId, text));
    this.#live = true;
    this.#error = undefined;
  }

  async stop(): Promise<void> {
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("line");
    await this.#unserve?.();
    this.#unserve = null;
  }

  health(): ConnectorHealth {
    return this.#live
      ? { live: true }
      : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseLineSession(sessionId);
    if (!target) return;
    for (const part of formatForChat(text, LINE_MAX)) {
      const res = await this.#api("POST", "/message/push", {
        to: target.to,
        messages: [{ type: "text", text: part }],
      });
      if (!res.ok) throw new Error(`line: push answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  #api(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    return fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  }

  /**
   * One webhook POST. Answers within LINE's deadline (it retries a slow
   * 200 as a failure): verify, take the events, return 200, and run the
   * agent afterwards. A bad signature is 401 and is logged, because on a
   * public address that is either a wrong secret or somebody else knocking.
   */
  async #onRequest(req: InboundRequest): Promise<Response> {
    if (!verifyLineSignature(this.#secret, req.body, req.headers.get("x-line-signature"))) {
      this.#ctx?.log("line: rejected a POST with a bad signature (wrong channel secret, or not LINE)");
      return new Response("bad signature", { status: 401 });
    }
    let events: LineEvent[];
    try {
      events = ((JSON.parse(Buffer.from(req.body).toString("utf8")) as { events?: LineEvent[] }).events) ?? [];
    } catch {
      return new Response("bad json", { status: 400 });
    }
    // The console's "Verify" button sends an empty events list; 200 is the
    // whole answer and is what makes the button go green.
    for (const ev of events) void this.#onEvent(ev);
    return new Response("ok", { status: 200 });
  }

  async #onEvent(ev: LineEvent): Promise<void> {
    if (ev.type !== "message" || ev.message?.type !== "text") return;
    const text = ev.message.text?.trim();
    const userId = ev.source?.userId;
    if (!text || !userId) return;

    if (ev.webhookEventId) {
      if (this.#seen.has(ev.webhookEventId)) return;
      this.#seen.add(ev.webhookEventId);
      if (this.#seen.size > 2000) this.#seen.delete(this.#seen.values().next().value!);
    }

    const src = ev.source!;
    const to = src.type === "group" ? src.groupId! : src.type === "room" ? src.roomId! : userId;
    // A group is answered only when it was named; a 1:1 chat needs no naming.
    if (src.type !== "user" && (this.#chats.size === 0 || !this.#chats.has(to))) return;

    await this.#handle(to, userId, text, ev.message.id);
  }

  async #handle(to: string, userId: string, text: string, messageId: string): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    ctx.onSender?.(userId, userId);
    if (!this.#allow.has(userId)) {
      ctx.log(`line: ignored message from non-allowlisted ${userId}`);
      return;
    }
    const sessionId = lineSessionId(to, userId);
    try {
      const command = await runChatCommand(ctx.agent, sessionId, text);
      if (command) {
        await this.send(sessionId, command);
        return;
      }
      if (ctx.askRouter.handleInbound(sessionId, text)) return;

      if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
      ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("LINE"));

      const { reply } = await runAgent(ctx.agent, sessionId, `[user:${userId}] ${text}`, `line-${messageId}`);
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`line: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e)).catch(() => {});
    }
  }
}

registerTransport("line", () => new LineConnector());
