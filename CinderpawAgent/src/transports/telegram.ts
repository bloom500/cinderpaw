/**
 * Telegram — the one that needs nothing from the machine it runs on.
 *
 * Chosen as the first of the OpenClaw 21 for exactly that reason. Five of the
 * remaining platforms are webhook-inbound (Twilio SMS, Google Chat, LINE,
 * Teams, Synology Chat) and cannot work at all until Cinderpaw has a public
 * URL, which a person running this at home does not have. Telegram's Bot API
 * offers long polling: WE call THEM and hold the request open. Nothing to
 * expose, nothing to install, no tunnel.
 *
 * This list named Zalo and Nextcloud Talk until 2026-09-12 and was wrong about
 * both. Zalo's Bot API long-polls with `getUpdates` by default and webhooks
 * are the option; Nextcloud Talk has a user-facing chat API next to its bot
 * webhook, and `nextcloud-talk.ts` polls that instead. A comment that names
 * platforms goes stale, so the current answer lives in
 * `docs/openclaw-import.md`, not here.
 *
 * No dependency either. OpenClaw's Telegram extension is 63,109 lines and
 * pulls `grammy` plus two plugins; what we need from that surface is two
 * endpoints, `getUpdates` and `sendMessage`, so this is plain fetch. The
 * protocol details worth stealing from them are the ones below — the offset
 * discipline, the 409, the 4096 limit — not the framework around them.
 *
 * ponytail: no media, no inline keyboards, no edited-message handling. Text
 * both ways, which is what every other connector here does. Add a piece the
 * day someone asks for that piece.
 */

import {
  connectorErrorMessage,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief, formatForChat } from "./chat-format.ts";
import { registerTransport, type ConnectorContext, type LiveConnector } from "./registry.ts";

/** Telegram rejects a sendMessage body over 4096 characters. */
const TELEGRAM_MAX = 4000;

/**
 * How long Telegram holds an empty `getUpdates` open before answering.
 *
 * 50s, not the 0 the API defaults to: at 0 this becomes a busy loop that
 * spends a request every few milliseconds and gets the bot rate-limited. The
 * fetch timeout below is deliberately longer, so a slow but healthy long poll
 * is never mistaken for a dead connection.
 */
const POLL_SECONDS = 50;
const POLL_TIMEOUT_MS = (POLL_SECONDS + 15) * 1000;

export function telegramSessionId(chatId: number | string, userId: number | string): string {
  return `telegram:${chatId}:${userId}`;
}

export function parseTelegramSession(
  sessionId: string,
): { chatId: string; userId: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[0] !== "telegram") return null;
  return { chatId: parts[1]!, userId: parts[2]! };
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; is_bot?: boolean; username?: string };
    chat: { id: number; type: string };
    text?: string;
  };
}

export class TelegramConnector implements LiveConnector {
  #token = "";
  #ctx: ConnectorContext | null = null;
  #running = false;
  #live = false;
  #error: string | undefined;
  #allow = new Set<string>();
  #chats = new Set<string>();
  #selfId = 0;
  /**
   * The update_id to ask from next. Telegram only forgets an update once you
   * acknowledge it by asking for a HIGHER offset, so this is also the ack.
   * Kept in memory on purpose: after a restart we re-read whatever is still
   * pending, which replays at most a few messages. Persisting it would mean a
   * crash mid-turn silently swallows the message that caused the crash.
   */
  #offset = 0;

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    const token = (ctx.secrets.TELEGRAM_BOT_TOKEN ?? "").trim();
    if (!token) {
      throw new Error(
        "telegram: enabled but no bot token (expected secrets.TELEGRAM_BOT_TOKEN — talk to @BotFather to get one)",
      );
    }
    this.#token = token;

    // Learn our own id before going live, the same reason as Mattermost: a bot
    // that cannot recognise itself answers its own messages forever. This also
    // validates the token, so a typo fails here with a sentence rather than as
    // a silent connector that never receives anything.
    const me = await this.#api("getMe");
    if (!me.ok) {
      throw new Error(
        me.status === 401
          ? "telegram: Telegram rejected the bot token — check it with @BotFather, or paste it again"
          : `telegram: Telegram answered HTTP ${me.status} to getMe`,
      );
    }
    this.#selfId = ((await me.json()) as { result?: { id?: number } }).result?.id ?? 0;

    this.#allow = new Set((ctx.row.allowlist ?? []).map((s) => s.trim()).filter(Boolean));
    this.#chats = new Set((ctx.row.channels ?? []).map((s) => s.trim()).filter(Boolean));
    ctx.log(
      `telegram: connected as ${this.#selfId} (${
        this.#allow.size === 0
          ? "0 allowed — NOBODY CAN REACH IT: the allowlist is empty, so every message is ignored. " +
            "Add Telegram numeric user ids to the allowlist to make it answer."
          : `${this.#allow.size} allowed`
      })`,
    );

    ctx.askRouter.registerSender("telegram", (sessionId, text) => this.send(sessionId, text));
    this.#running = true;
    this.#live = true;
    this.#error = undefined;
    void this.#poll();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("telegram");
  }

  health(): ConnectorHealth {
    return this.#live
      ? { live: true }
      : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseTelegramSession(sessionId);
    if (!target) return;
    for (const part of formatForChat(text, TELEGRAM_MAX)) {
      await this.#api("sendMessage", { chat_id: target.chatId, text: part });
    }
  }

  #api(method: string, body?: unknown): Promise<Response> {
    return fetch(`https://api.telegram.org/bot${this.#token}/${method}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
  }

  /** The long-poll loop. Runs until `stop()`, and survives its own errors. */
  async #poll(backoffMs = 1000): Promise<void> {
    while (this.#running) {
      try {
        const res = await this.#api("getUpdates", {
          offset: this.#offset,
          timeout: POLL_SECONDS,
          allowed_updates: ["message"],
        });
        // 409 is Telegram saying a SECOND client is polling this bot — another
        // Cinderpaw, or a webhook still registered from a previous setup. It
        // never resolves by retrying, and both clients lose messages at
        // random, so it is said out loud instead of hidden in a backoff.
        if (res.status === 409) {
          this.#live = false;
          this.#error =
            "another program is already receiving this bot's messages (Telegram 409). " +
            "Stop the other Cinderpaw, or delete the bot's webhook, then re-enable this connector.";
          this.#ctx?.log(`telegram: ${this.#error}`);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const body = (await res.json()) as { ok?: boolean; result?: TelegramUpdate[] };
        this.#live = true;
        this.#error = undefined;
        backoffMs = 1000;

        for (const update of body.result ?? []) {
          // Advance the offset BEFORE handling. A message that makes the agent
          // throw would otherwise be re-delivered on the next poll, for ever,
          // and the connector would never move past it.
          this.#offset = Math.max(this.#offset, update.update_id + 1);
          // Not awaited: a turn can be waiting on this person's NEXT message (an
          // ask_user question, an approval), and that message only arrives through
          // the next poll. Awaiting here left every such question unanswered until it
          // timed out. Turns in one session still run in order: AgentLoop queues them.
          void this.#onUpdate(update).catch((e) => this.#ctx?.log(`telegram: message error: ${String(e)}`));
        }
      } catch (e) {
        if (!this.#running) return;
        // A long poll that times out with no traffic is the normal, quiet
        // case, not a fault: go straight round again rather than backing off
        // and adding latency to the next real message.
        const timedOut = e instanceof Error && e.name === "TimeoutError";
        if (!timedOut) {
          this.#live = false;
          this.#error = String(e);
          this.#ctx?.log(`telegram: poll failed (${String(e)}), retrying in ${Math.round(backoffMs / 1000)}s`);
          await new Promise((r) => setTimeout(r, backoffMs));
          backoffMs = Math.min(backoffMs * 2, 60_000);
        }
      }
    }
  }

  async #onUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    const text = msg?.text?.trim();
    const from = msg?.from;
    if (!msg || !text || !from) return;
    if (from.is_bot || from.id === this.#selfId) return;

    const chatId = String(msg.chat.id);
    // A group is answered only when it was named. A private chat is a DM and
    // needs no naming — same rule as every other connector here.
    if (msg.chat.type !== "private" && this.#chats.size > 0 && !this.#chats.has(chatId)) return;
    if (msg.chat.type !== "private" && this.#chats.size === 0) return;

    await this.#handle(chatId, String(from.id), text, msg.message_id);
  }

  async #handle(chatId: string, userId: string, text: string, messageId: number): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    if (!this.#allow.has(userId)) {
      ctx.log(`telegram: ignored message from non-allowlisted ${userId}`);
      return;
    }
    const sessionId = telegramSessionId(chatId, userId);

    const command = await runChatCommand(ctx.agent, sessionId, text);
    if (command) {
      await this.send(sessionId, command);
      return;
    }
    if (ctx.askRouter.handleInbound(sessionId, text)) return;

    if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
    ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("Telegram"));

    try {
      const { reply } = await runAgent(
        ctx.agent,
        sessionId,
        `[user:${userId}] ${text}`,
        `telegram-${messageId}`,
      );
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`telegram: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e));
    }
  }
}

registerTransport("telegram", () => new TelegramConnector());
