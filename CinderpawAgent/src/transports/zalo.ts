/**
 * Zalo — Telegram's shape, and one trap that is not Telegram's.
 *
 * Zalo is the default messenger in Vietnam, and its Bot API is deliberately
 * modelled on Telegram's: `https://bot-api.zaloplatforms.com/bot<token>/<method>`,
 * long polling with `getUpdates`, and the same `{ ok, result, description,
 * error_code }` envelope. So this is `telegram.ts` with different nouns, and
 * needs no public URL either.
 *
 * This repo claimed for a while that Zalo was webhook-only. It is not: webhooks
 * are the option and long polling is the default. See
 * `docs/openclaw-import.md` for how that error survived three commits.
 *
 * **The trap, measured on 2026-09-12 with a deliberately invalid token:** Zalo
 * answers a rejected token with `HTTP 200` and `{"ok":false,"description":
 * "Unauthorized","error_code":401}`. Telegram answers with HTTP 401. So
 * `if (!res.ok)` — the check every other transport in this directory uses — is
 * blind here: a wrong token looks like a successful request that happened to
 * carry no messages, and the connector would sit reporting healthy forever
 * while the person waits for a reply that cannot come. Every call goes through
 * `#call` below, which reads the envelope and never the status alone.
 *
 * What is verified and what is not, said plainly because nobody here has a Zalo
 * account: the host, the path shape, the envelope and the 200-with-ok-false
 * behaviour were probed directly. The field names inside `result` follow
 * Telegram's documented shape and are NOT confirmed against a live bot. They
 * are read defensively, so an unexpected shape yields no message rather than a
 * crash, and `ctx.log` says a message was dropped.
 *
 * ponytail: this duplicates roughly half of telegram.ts. Two implementations do
 * not justify a shared base class; a third Telegram-shaped Bot API would, and
 * then the offset discipline and the envelope reader are what to lift.
 */

import {
  connectorErrorMessage,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief, formatForChat } from "./chat-format.ts";
import { registerTransport, type ConnectorContext, type LiveConnector } from "./registry.ts";

const ZALO_API = "https://bot-api.zaloplatforms.com";

/** Conservative: Zalo does not document a limit, and Telegram's is 4096. */
const ZALO_MAX = 4000;

const POLL_SECONDS = 50;
const POLL_TIMEOUT_MS = (POLL_SECONDS + 15) * 1000;

export function zaloSessionId(chatId: string, userId: string): string {
  return `zalo:${chatId}:${userId}`;
}

export function parseZaloSession(sessionId: string): { chatId: string; userId: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[0] !== "zalo") return null;
  return { chatId: parts[1]!, userId: parts[2]! };
}

export interface ZaloEnvelope {
  ok?: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
}

/**
 * Read the envelope, not the HTTP status.
 *
 * Returns the `result` on success and throws with Zalo's own words on failure.
 * Split out and exported because it is the one piece of this file that can be
 * tested without a Zalo account, and it is the piece that decides whether a
 * wrong token is visible or silent.
 */
export function unwrapZalo(status: number, body: unknown): unknown {
  if (!body || typeof body !== "object") {
    throw new Error(`zalo: the server answered HTTP ${status} with something that is not a reply`);
  }
  const envelope = body as ZaloEnvelope;
  if (envelope.ok === true) return envelope.result;
  const code = envelope.error_code ?? status;
  const why = envelope.description ?? `HTTP ${status}`;
  if (code === 401) {
    throw new Error(
      "zalo: Zalo rejected the bot token — create a new one at https://bot.zaloplatforms.com and paste it again",
    );
  }
  throw new Error(`zalo: ${why} (error ${code})`);
}

interface ZaloUpdate {
  update_id?: number;
  message?: {
    message_id?: number | string;
    from?: { id?: number | string; is_bot?: boolean };
    chat?: { id?: number | string };
    text?: string;
  };
}

export class ZaloConnector implements LiveConnector {
  #token = "";
  #ctx: ConnectorContext | null = null;
  #running = false;
  #live = false;
  #error: string | undefined;
  #allow = new Set<string>();
  #chats = new Set<string>();
  #selfId = "";
  /** Same discipline as Telegram: asking for a higher offset is the ack, and
   *  it is kept in memory so a crash mid-turn replays rather than swallows. */
  #offset = 0;

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    const token = (ctx.secrets.ZALO_BOT_TOKEN ?? "").trim();
    if (!token) {
      throw new Error(
        "zalo: enabled but no bot token (expected secrets.ZALO_BOT_TOKEN — create a bot at https://bot.zaloplatforms.com)",
      );
    }
    this.#token = token;

    // Validates the token AND learns our own id, so a typo fails here with a
    // sentence rather than as a connector that receives nothing forever.
    const me = (await this.#call("getMe")) as { id?: number | string } | null;
    this.#selfId = String(me?.id ?? "");

    this.#allow = new Set((ctx.row.allowlist ?? []).map((s) => s.trim()).filter(Boolean));
    this.#chats = new Set((ctx.row.channels ?? []).map((s) => s.trim()).filter(Boolean));
    ctx.log(
      `zalo: connected as ${this.#selfId || "(unknown id)"} (${
        this.#allow.size === 0
          ? "0 allowed — NOBODY CAN REACH IT: the allowlist is empty, so every message is ignored. " +
            "Add Zalo numeric user ids to the allowlist to make it answer."
          : `${this.#allow.size} allowed`
      })`,
    );

    ctx.askRouter.registerSender("zalo", (sessionId, text) => this.send(sessionId, text));
    this.#running = true;
    this.#live = true;
    this.#error = undefined;
    void this.#poll();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("zalo");
  }

  health(): ConnectorHealth {
    return this.#live
      ? { live: true }
      : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseZaloSession(sessionId);
    if (!target) return;
    for (const part of formatForChat(text, ZALO_MAX)) {
      await this.#call("sendMessage", { chat_id: target.chatId, text: part });
    }
  }

  /** Every call goes through here, so nothing in this file reads `res.ok`. */
  async #call(method: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${ZALO_API}/bot${this.#token}/${method}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      throw new Error(`zalo: the server answered HTTP ${res.status} with something that is not JSON`);
    }
    return unwrapZalo(res.status, parsed);
  }

  /** The long-poll loop. Runs until `stop()`, and survives its own errors. */
  async #poll(backoffMs = 1000): Promise<void> {
    while (this.#running) {
      try {
        const result = (await this.#call("getUpdates", {
          offset: this.#offset,
          timeout: POLL_SECONDS,
        })) as ZaloUpdate[] | null;
        this.#live = true;
        this.#error = undefined;
        backoffMs = 1000;

        for (const update of Array.isArray(result) ? result : []) {
          const id = Number(update.update_id);
          // Advance BEFORE handling: a message that makes the agent throw must
          // not be redelivered forever.
          if (Number.isFinite(id)) this.#offset = Math.max(this.#offset, id + 1);
          // Not awaited: a turn can be waiting on this person's NEXT message (an
          // ask_user question, an approval), and that message only arrives through
          // the next poll. Awaiting here left every such question unanswered until it
          // timed out. Turns in one session still run in order: AgentLoop queues them.
          void this.#onUpdate(update).catch((e) => this.#ctx?.log(`zalo: message error: ${String(e)}`));
        }
      } catch (e) {
        if (!this.#running) return;
        const message = String(e);
        this.#live = false;
        this.#error = message;
        // A revoked or wrong token never resolves by retrying, and retrying it
        // is how a bot ends up rate-limited on top of being broken.
        if (message.includes("rejected the bot token")) {
          this.#running = false;
          this.#ctx?.log(`zalo: ${message}`);
          return;
        }
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }

  async #onUpdate(update: ZaloUpdate): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    const message = update.message;
    if (!message) return;
    const chatId = String(message.chat?.id ?? "");
    const userId = String(message.from?.id ?? "");
    const text = (message.text ?? "").trim();
    if (!chatId || !userId || !text) {
      // Not silent: the update shape is the part nobody could verify without a
      // Zalo account, so a message we cannot read has to leave a trace.
      if (message.chat || message.from) {
        ctx.log("zalo: dropped an update whose chat, sender or text was missing");
      }
      return;
    }
    if (message.from?.is_bot) return;
    if (userId === this.#selfId) return;
    if (this.#chats.size > 0 && !this.#chats.has(chatId)) return;

    ctx.onSender?.(userId, userId);
    if (!this.#allow.has(userId)) {
      ctx.log(`zalo: ignored message from non-allowlisted ${userId}`);
      return;
    }

    const sessionId = zaloSessionId(chatId, userId);

    const command = await runChatCommand(ctx.agent, sessionId, text);
    if (command) {
      await this.send(sessionId, command);
      return;
    }
    if (ctx.askRouter.handleInbound(sessionId, text)) return;

    if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
    ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("Zalo"));

    try {
      const { reply } = await runAgent(
        ctx.agent,
        sessionId,
        `[user:${userId}] ${text}`,
        `zalo-${message.message_id ?? update.update_id ?? Date.now()}`,
      );
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`zalo: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e));
    }
  }
}

registerTransport("zalo", () => new ZaloConnector());
