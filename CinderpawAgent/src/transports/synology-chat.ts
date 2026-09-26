/**
 * Synology Chat — the third connector on the inbound receiver, and the one
 * whose "public address" is usually a LAN address.
 *
 * Chat's bot integration is two webhooks the NAS admin creates: an OUTGOING
 * one (the NAS POSTs each message to us as a form: `token`, `user_id`,
 * `username`, `text`, ...) and an INCOMING one (a URL on the NAS we POST
 * `payload={"text":...,"user_ids":[...]}` to). There is no HMAC: the outgoing
 * webhook's token in the form IS the proof, compared in constant time.
 *
 * The NAS is another box on the same network, so the receiver's default
 * loopback bind can never be reached from it. That is said on screen at
 * start, with the setting that fixes it, because a silent connector that
 * "connected" and never hears anything is the failure this repo keeps
 * finding.
 *
 * ponytail: text only, replies as a DM to the sender (`user_ids`), no
 * channel posting, no attachments.
 */

import { timingSafeEqual } from "node:crypto";
import {
  connectorErrorMessage,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief, formatForChat } from "./chat-format.ts";
import { inboundAddress, inboundPath, serveInbound, type InboundRequest } from "./inbound.ts";
import { registerTransport, type ConnectorContext, type LiveConnector } from "./registry.ts";

const SYNOLOGY_MAX = 2000;

export function synologySessionId(userId: string): string {
  return `synology-chat:${userId}`;
}

export function parseSynologySession(sessionId: string): { userId: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 2 || parts[0] !== "synology-chat" || !parts[1]) return null;
  return { userId: parts[1] };
}

/** The outgoing webhook token, compared without leaking where it differs. */
export function verifySynologyToken(expected: string, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class SynologyChatConnector implements LiveConnector {
  #incoming = "";
  #token = "";
  #ctx: ConnectorContext | null = null;
  #live = false;
  #error: string | undefined;
  #allow = new Set<string>();
  #unserve: (() => Promise<void>) | null = null;
  #seen = new Set<string>();

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    const field = (k: string) => (ctx.row.metadata?.[k] ?? ctx.secrets[k] ?? "").trim();
    this.#incoming = field("SYNOLOGY_CHAT_WEBHOOK_URL");
    this.#token = field("SYNOLOGY_CHAT_TOKEN");
    if (!/^https?:\/\//.test(this.#incoming) || !this.#token) {
      throw new Error(
        "synology-chat: enabled but missing the incoming webhook URL or the outgoing webhook token " +
          "(Chat → Integration: create an Incoming webhook and copy its URL; create an Outgoing webhook and copy its token)",
      );
    }

    this.#allow = new Set((ctx.row.allowlist ?? []).map((s) => s.trim()).filter(Boolean));
    this.#unserve = await serveInbound("synology-chat", (req) => this.#onRequest(req), ctx.log);
    const { host, port } = inboundAddress();
    ctx.log(
      `synology-chat: connected (${
        this.#allow.size === 0
          ? "0 allowed — NOBODY CAN REACH IT: the allowlist is empty, so every message is ignored. " +
            "Add Chat user ids (the number in the outgoing webhook's user_id) to the allowlist to make it answer."
          : `${this.#allow.size} allowed`
      }). Outgoing webhook URL for the NAS: http://<this computer's LAN address>:${port}${inboundPath("synology-chat")}`,
    );
    if (host === "127.0.0.1" || host === "localhost") {
      ctx.log(
        "synology-chat: the receiver is bound to loopback, which a NAS on your network CANNOT reach. " +
          "Set CINDERPAW_INBOUND_HOST=0.0.0.0 and re-enable this connector (Windows will ask to allow it through the firewall).",
      );
    }

    ctx.askRouter.registerSender("synology-chat", (sessionId, text) => this.send(sessionId, text));
    this.#live = true;
    this.#error = undefined;
  }

  async stop(): Promise<void> {
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("synology-chat");
    await this.#unserve?.();
    this.#unserve = null;
  }

  health(): ConnectorHealth {
    return this.#live
      ? { live: true }
      : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseSynologySession(sessionId);
    if (!target) return;
    for (const part of formatForChat(text, SYNOLOGY_MAX)) {
      const res = await fetch(this.#incoming, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          payload: JSON.stringify({ text: part, user_ids: [Number(target.userId)] }),
        }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`synology-chat: the NAS answered HTTP ${res.status} to the incoming webhook`);
    }
  }

  async #onRequest(req: InboundRequest): Promise<Response> {
    const params = new URLSearchParams(Buffer.from(req.body).toString("utf8"));
    if (!verifySynologyToken(this.#token, params.get("token"))) {
      this.#ctx?.log("synology-chat: rejected a POST with a bad token (wrong outgoing webhook token, or not your NAS)");
      return new Response("bad token", { status: 401 });
    }
    void this.#onMessage(params);
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }

  async #onMessage(p: URLSearchParams): Promise<void> {
    const userId = p.get("user_id")?.trim();
    const text = p.get("text")?.trim();
    const postId = p.get("post_id") ?? "";
    if (!userId || !text) return;
    if (postId) {
      if (this.#seen.has(postId)) return;
      this.#seen.add(postId);
      if (this.#seen.size > 2000) this.#seen.delete(this.#seen.values().next().value!);
    }
    const ctx = this.#ctx;
    if (!ctx) return;
    ctx.onSender?.(userId, userId);
    if (!this.#allow.has(userId)) {
      ctx.log(`synology-chat: ignored a message from non-allowlisted user ${userId} (${p.get("username") ?? "?"})`);
      return;
    }
    const sessionId = synologySessionId(userId);
    try {
      const command = await runChatCommand(ctx.agent, sessionId, text);
      if (command) {
        await this.send(sessionId, command);
        return;
      }
      if (ctx.askRouter.handleInbound(sessionId, text)) return;

      if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
      ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("Synology Chat"));

      const { reply } = await runAgent(ctx.agent, sessionId, `[user:${userId}] ${text}`, `synology-${postId || Date.now()}`);
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`synology-chat: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e)).catch(() => {});
    }
  }
}

registerTransport("synology-chat", () => new SynologyChatConnector());
