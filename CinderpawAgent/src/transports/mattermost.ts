/**
 * Mattermost — the same pairing over a different wire.
 *
 * Matrix and Mattermost both pair with an instance token, and neither one is a
 * bot token or an OAuth grant. What differs is the wire: Matrix long-polls
 * over HTTP, Mattermost holds a WebSocket open and posts over REST. That is
 * the whole reason both exist in this phase — `transport` and `pairing` are
 * two axes, and a connector surface that conflates them can only ever grow one
 * connector at a time.
 *
 * Personal access tokens do not expire, so there is no refresh here. The
 * failure that does happen is the token being revoked, and that is said out
 * loud rather than retried forever.
 */

import {
  connectorErrorMessage,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief, formatForChat } from "./chat-format.ts";
import { registerTransport, type ConnectorContext, type LiveConnector } from "./registry.ts";

/** Mattermost's own limit on a post is 16383 characters. */
const MATTERMOST_MAX = 15_000;

export function mattermostSessionId(channelId: string, userId: string): string {
  return `mattermost:${channelId}:${userId}`;
}

export function parseMattermostSession(
  sessionId: string,
): { channelId: string; userId: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[0] !== "mattermost") return null;
  return { channelId: parts[1]!, userId: parts[2]! };
}

export class MattermostConnector implements LiveConnector {
  #base = "";
  #token = "";
  #selfId = "";
  #ctx: ConnectorContext | null = null;
  #socket: WebSocket | null = null;
  #running = false;
  #live = false;
  #error: string | undefined;
  #allow = new Set<string>();
  #channels = new Set<string>();
  #seq = 1;

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    // Metadata first, `secrets` second — see matrix.ts for why the instance
    // address is configuration and not a credential.
    const base = (ctx.row.metadata?.MATTERMOST_URL ?? ctx.secrets.MATTERMOST_URL ?? "").trim();
    const token = (ctx.secrets.MATTERMOST_TOKEN ?? "").trim();
    if (!base) {
      throw new Error(
        "mattermost: no server address — Cinderpaw cannot tell which Mattermost to connect to (expected MATTERMOST_URL, e.g. https://chat.yourcompany.com)",
      );
    }
    if (!token) {
      throw new Error("mattermost: enabled but no access token (expected secrets.MATTERMOST_TOKEN)");
    }
    this.#base = base.replace(/\/+$/, "");
    this.#token = token;

    // Verify the token and learn our own id before claiming to be live —
    // without the id the bot answers its own posts forever.
    const me = await this.#api("GET", "/api/v4/users/me");
    if (!me.ok) {
      throw new Error(
        me.status === 401
          ? "mattermost: the server rejected the access token — it may have been revoked"
          : `mattermost: the server answered HTTP ${me.status}`,
      );
    }
    this.#selfId = ((await me.json()) as { id?: string }).id ?? "";

    this.#allow = new Set((ctx.row.allowlist ?? []).map((s) => s.trim()).filter(Boolean));
    this.#channels = new Set((ctx.row.channels ?? []).map((s) => s.trim()).filter(Boolean));
    ctx.log(
      `mattermost: connected as ${this.#selfId} (${this.#allow.size} allowed${
        this.#allow.size === 0 ? " — nobody can talk to it until you add someone" : ""
      })`,
    );

    ctx.askRouter.registerSender("mattermost", (sessionId, text) => this.send(sessionId, text));
    this.#running = true;
    this.#live = true;
    this.#error = undefined;
    this.#connectSocket();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("mattermost");
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
    const target = parseMattermostSession(sessionId);
    if (!target) return;
    for (const part of formatForChat(text, MATTERMOST_MAX)) {
      await this.#api("POST", "/api/v4/posts", { channel_id: target.channelId, message: part });
    }
  }

  #api(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.#base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  /** Open the event socket, and put it back up if it drops. */
  #connectSocket(backoffMs = 1000): void {
    if (!this.#running) return;
    const url = `${this.#base.replace(/^http/, "ws")}/api/v4/websocket`;
    let socket: WebSocket;
    try {
      // Bun accepts per-connection headers; Mattermost authenticates the
      // socket with the same bearer token as the REST API.
      socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.#token}` },
      } as unknown as string[]);
    } catch (e) {
      this.#error = String(e);
      this.#retry(backoffMs);
      return;
    }
    this.#socket = socket;

    socket.addEventListener("message", (ev) => {
      void this.#onFrame(String((ev as MessageEvent).data ?? ""));
    });
    socket.addEventListener("open", () => {
      this.#live = true;
      this.#error = undefined;
    });
    socket.addEventListener("close", () => {
      if (!this.#running) return;
      this.#live = false;
      this.#error = "the connection to the server dropped";
      this.#retry(backoffMs);
    });
    socket.addEventListener("error", () => {
      // `close` follows an `error`, and doing the retry in both places is how
      // you get two sockets.
      this.#live = false;
    });
  }

  #retry(backoffMs: number): void {
    if (!this.#running) return;
    this.#ctx?.log(`mattermost: reconnecting in ${Math.round(backoffMs / 1000)}s`);
    setTimeout(() => this.#connectSocket(Math.min(backoffMs * 2, 60_000)), backoffMs);
  }

  async #onFrame(raw: string): Promise<void> {
    let frame: { event?: string; data?: Record<string, unknown> };
    try {
      frame = JSON.parse(raw);
    } catch {
      return; // a frame we cannot read is not a frame we can act on
    }
    if (frame.event !== "posted") return;
    // Mattermost sends the post as a JSON STRING inside the frame, not as an
    // object. Parsing it twice is the protocol, not a mistake.
    const post = safeParse(frame.data?.post);
    if (!post) return;
    const userId = String(post.user_id ?? "");
    const channelId = String(post.channel_id ?? "");
    const message = String(post.message ?? "").trim();
    if (!userId || !channelId || !message) return;
    if (userId === this.#selfId) return;
    if (this.#channels.size > 0 && !this.#channels.has(channelId)) return;
    await this.#handle(channelId, userId, message, String(post.id ?? ""));
  }

  async #handle(channelId: string, userId: string, text: string, postId: string): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    if (!this.#allow.has(userId)) {
      ctx.log(`mattermost: ignored message from non-allowlisted ${userId}`);
      return;
    }
    const sessionId = mattermostSessionId(channelId, userId);

    const command = await runChatCommand(ctx.agent, sessionId, text);
    if (command) {
      await this.send(sessionId, command);
      return;
    }
    if (ctx.askRouter.handleInbound(sessionId, text)) return;

    if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
    ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("Mattermost"));

    try {
      const { reply } = await runAgent(
        ctx.agent,
        sessionId,
        `[user:${userId}] ${text}`,
        `mattermost-${postId || this.#seq++}`,
      );
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`mattermost: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e));
    }
  }
}

function safeParse(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

registerTransport("mattermost", () => new MattermostConnector());
