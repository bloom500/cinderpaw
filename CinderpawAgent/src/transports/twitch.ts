/**
 * Twitch — a credential with a life of its own.
 *
 * Discord and Slack hand you a bot token that lives until you delete it.
 * Twitch hands you an access token that dies in four hours and a refresh token
 * that is SINGLE USE. That is the whole reason this connector is in the phase:
 * everything before it could treat "we have a credential" as a permanent fact,
 * and this one cannot.
 *
 * Chat is IRC over a WebSocket. Two failures matter and they look nothing
 * alike from the outside:
 *
 *   - the socket drops     → reconnect, quietly, with backoff
 *   - the login is refused → stop, and say so
 *
 * The second is what a token expiring looks like from in here, and retrying it
 * forever behind a green light is precisely the silence this whole connector
 * surface exists to end. Renewal itself belongs to the host — it holds the
 * vault and the client id — so this reports the state and lets the host act.
 */

import {
  connectorErrorMessage,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief, formatForChat } from "./chat-format.ts";
import { registerTransport, type ConnectorContext, type LiveConnector } from "./registry.ts";

const TWITCH_IRC = "wss://irc-ws.chat.twitch.tv:443";
/** Twitch drops a PRIVMSG over 500 characters. */
const TWITCH_MAX = 480;

export function twitchSessionId(channel: string, user: string): string {
  return `twitch:${channel}:${user}`;
}

export function parseTwitchSession(sessionId: string): { channel: string; user: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[0] !== "twitch") return null;
  return { channel: parts[1]!, user: parts[2]! };
}

/** `@tags :sam!sam@sam.tmi.twitch.tv PRIVMSG #chan :hello there` */
export function parsePrivmsg(line: string): { user: string; channel: string; text: string } | null {
  const body = line.startsWith("@") ? line.slice(line.indexOf(" ") + 1) : line;
  const m = /^:([^!]+)![^ ]+ PRIVMSG #([^ ]+) :([\s\S]*)$/.exec(body);
  if (!m) return null;
  return { user: m[1]!, channel: m[2]!, text: m[3]!.replace(/[\r\n]+$/, "") };
}

export class TwitchConnector implements LiveConnector {
  #ctx: ConnectorContext | null = null;
  #socket: WebSocket | null = null;
  #login = "";
  #token = "";
  #channels: string[] = [];
  #allow = new Set<string>();
  #running = false;
  #live = false;
  #error: string | undefined;
  #seq = 1;

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    // Granted by the device flow and stored in the vault, not typed into a
    // form — Twitch's pairing has no form at all.
    this.#token = (ctx.secrets.OAUTH_ACCESS ?? "").trim();
    // Learned once, at pairing, from the provider. IRC refuses a NICK that
    // does not match the token, and asking the person to retype a username
    // Cinderpaw already knows is asking them to do our bookkeeping.
    this.#login = (ctx.row.metadata?.TWITCH_LOGIN ?? "").trim().toLowerCase();

    if (!this.#token) {
      throw new Error("twitch: not connected yet — pair the account first (no access token in the vault)");
    }
    if (!this.#login) {
      throw new Error("twitch: the account name is missing — disconnect and pair again so Cinderpaw can read it back");
    }

    this.#channels = (ctx.row.channels ?? [])
      .map((c) => c.trim().replace(/^#/, "").toLowerCase())
      .filter(Boolean);
    if (this.#channels.length === 0) {
      // A Twitch bot with no channel is not connected to anything. Silence
      // here would look exactly like a broken token.
      this.#channels = [this.#login];
      ctx.log(`twitch: no channels configured — joining your own channel #${this.#login}`);
    }
    this.#allow = new Set(
      (ctx.row.allowlist ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean),
    );
    ctx.log(
      `twitch: connecting as ${this.#login} (${this.#allow.size} allowed${
        this.#allow.size === 0 ? " — nobody can talk to it until you add someone" : ""
      }, ${this.#channels.length} channel(s))`,
    );

    ctx.askRouter.registerSender("twitch", (sessionId, text) => this.send(sessionId, text));
    this.#running = true;
    this.#connect();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("twitch");
    const s = this.#socket;
    this.#socket = null;
    try {
      s?.close();
    } catch {
      // already gone
    }
  }

  health(): ConnectorHealth {
    return this.#live ? { live: true } : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseTwitchSession(sessionId);
    if (!target || !this.#socket) return;
    for (const part of formatForChat(text, TWITCH_MAX)) {
      this.#raw(`PRIVMSG #${target.channel} :${part.replace(/[\r\n]+/g, " ")}`);
    }
  }

  #raw(line: string): void {
    try {
      this.#socket?.send(`${line}\r\n`);
    } catch (e) {
      this.#ctx?.log(`twitch: could not write to chat: ${String(e)}`);
    }
  }

  #connect(backoffMs = 1000): void {
    if (!this.#running) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(TWITCH_IRC);
    } catch (e) {
      this.#error = String(e);
      this.#retry(backoffMs);
      return;
    }
    this.#socket = socket;

    socket.addEventListener("open", () => {
      // Tags carry the display name and the message id; commands carry the
      // NOTICE that says an expired token was refused.
      this.#raw("CAP REQ :twitch.tv/tags twitch.tv/commands");
      this.#raw(`PASS oauth:${this.#token}`);
      this.#raw(`NICK ${this.#login}`);
    });
    socket.addEventListener("message", (ev) => {
      for (const line of String((ev as MessageEvent).data ?? "").split(/\r?\n/)) {
        if (line.trim()) void this.#onLine(line);
      }
    });
    socket.addEventListener("close", () => {
      if (!this.#running) return;
      this.#live = false;
      this.#error ??= "the connection to Twitch chat dropped";
      this.#retry(backoffMs);
    });
    socket.addEventListener("error", () => {
      this.#live = false;
    });
  }

  #retry(backoffMs: number): void {
    if (!this.#running) return;
    this.#ctx?.log(`twitch: reconnecting in ${Math.round(backoffMs / 1000)}s`);
    setTimeout(() => this.#connect(Math.min(backoffMs * 2, 60_000)), backoffMs);
  }

  async #onLine(line: string): Promise<void> {
    // Keepalive. Missing it gets the connection closed by the server, which
    // then looks like a mysterious drop.
    if (line.startsWith("PING")) {
      this.#raw(`PONG ${line.slice(5) || ":tmi.twitch.tv"}`);
      return;
    }
    // Login refused. This is what an expired or revoked token looks like from
    // inside chat, and it will never fix itself by trying again.
    if (/NOTICE \* :(Login authentication failed|Improperly formatted auth)/i.test(line)) {
      this.#live = false;
      this.#error = "Twitch refused the login — the connection needs renewing";
      this.#ctx?.log(`twitch: ${this.#error}`);
      this.#running = false;
      try {
        this.#socket?.close();
      } catch {
        // already gone
      }
      this.#socket = null;
      return;
    }
    // Welcome: authenticated. Only now is this connector honestly live.
    if (/ 001 /.test(line)) {
      this.#live = true;
      this.#error = undefined;
      for (const channel of this.#channels) this.#raw(`JOIN #${channel}`);
      return;
    }
    const msg = parsePrivmsg(line);
    if (msg) await this.#handle(msg.channel, msg.user, msg.text);
  }

  async #handle(channel: string, user: string, text: string): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    if (user.toLowerCase() === this.#login) return; // never answer ourselves
    if (!this.#allow.has(user.toLowerCase())) {
      ctx.log(`twitch: ignored message from non-allowlisted ${user}`);
      return;
    }
    const sessionId = twitchSessionId(channel, user);

    const command = await runChatCommand(ctx.agent, sessionId, text);
    if (command) {
      await this.send(sessionId, command);
      return;
    }
    if (ctx.askRouter.handleInbound(sessionId, text)) return;

    if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
    ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("Twitch chat"));

    try {
      const { reply } = await runAgent(
        ctx.agent,
        sessionId,
        `[user:${user}] ${text}`,
        `twitch-${this.#seq++}`,
      );
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`twitch: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e));
    }
  }
}

registerTransport("twitch", () => new TwitchConnector());
