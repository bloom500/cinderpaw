/**
 * Matrix — talk to Cinderpaw from any homeserver, including your own.
 *
 * This is the connector that proves configuration which is **required but not
 * secret**. A Matrix account is meaningless without knowing which homeserver
 * it lives on, and that URL is public. Until connectors had somewhere else to
 * put it, the only field bag available was `secrets`, so a public address got
 * written into the OS keychain and became invisible to the person who typed
 * it. It now rides in `row.metadata`, with the old location still read so an
 * existing config keeps working.
 *
 * Session ids are `matrix:<room>:<user>` with both parts percent-encoded.
 * Matrix ids contain colons of their own (`!abc:example.org`,
 * `@sam:example.org`), so the obvious `split(":")` would tear them in half and
 * reply into a room that does not exist.
 */

import {
  connectorErrorMessage,
  mimeForName,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief, formatForChat } from "./chat-format.ts";
import {
  registerTransport,
  type ConnectorContext,
  type LiveConnector,
  type OutboundFile,
} from "./registry.ts";

/** Matrix caps an event at 64 KiB; stay well under it. */
const MATRIX_MAX = 4000;
/** How long the homeserver holds a `/sync` open before answering empty. */
const SYNC_TIMEOUT_MS = 30_000;
/** Floor between two syncs, for servers that ignore the timeout above. */
const MIN_SYNC_GAP_MS = 250;

export function matrixSessionId(roomId: string, userId: string): string {
  return `matrix:${encodeURIComponent(roomId)}:${encodeURIComponent(userId)}`;
}

/** Inverse of `matrixSessionId`. Returns null for anything that is not one. */
export function parseMatrixSession(sessionId: string): { roomId: string; userId: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[0] !== "matrix") return null;
  return { roomId: decodeURIComponent(parts[1]!), userId: decodeURIComponent(parts[2]!) };
}

interface MatrixEvent {
  type?: string;
  sender?: string;
  event_id?: string;
  content?: { msgtype?: string; body?: string };
}

export class MatrixConnector implements LiveConnector {
  #homeserver = "";
  #token = "";
  #selfId = "";
  #since: string | undefined;
  #running = false;
  #live = false;
  #error: string | undefined;
  #ctx: ConnectorContext | null = null;
  #allow = new Set<string>();
  #rooms = new Set<string>();

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    // Metadata first, `secrets` second: an install written before non-secret
    // fields had a home keeps working without the person doing anything.
    const homeserver = (
      ctx.row.metadata?.MATRIX_HOMESERVER ??
      ctx.secrets.MATRIX_HOMESERVER ??
      ""
    ).trim();
    const token = (ctx.secrets.MATRIX_ACCESS_TOKEN ?? "").trim();
    if (!homeserver) {
      throw new Error(
        "matrix: no homeserver address — Cinderpaw cannot tell which server your account is on (expected MATRIX_HOMESERVER, e.g. https://matrix.org)",
      );
    }
    if (!token) throw new Error("matrix: enabled but no access token (expected secrets.MATRIX_ACCESS_TOKEN)");
    this.#homeserver = homeserver.replace(/\/+$/, "");
    this.#token = token;

    // Who are we? Two reasons, both load-bearing: it verifies the token before
    // we claim to be live, and without our own id the bot answers its own
    // messages forever.
    const who = await this.#api("GET", "/_matrix/client/v3/account/whoami");
    if (!who.ok) {
      throw new Error(
        who.status === 401
          ? "matrix: the homeserver rejected the access token — it may have been revoked"
          : `matrix: the homeserver answered HTTP ${who.status}`,
      );
    }
    this.#selfId = ((await who.json()) as { user_id?: string }).user_id ?? "";

    this.#allow = new Set((ctx.row.allowlist ?? []).map((s) => s.trim()).filter(Boolean));
    this.#rooms = new Set((ctx.row.channels ?? []).map((s) => s.trim()).filter(Boolean));
    // The count belongs in the log at start, not in a silence later: an empty
    // allowlist means NOBODY, and a connector that answers no one looks
    // exactly like a connector that is down.
    ctx.log(
      `matrix: connected as ${this.#selfId} (${this.#allow.size} allowed${
        this.#allow.size === 0 ? " — nobody can talk to it until you add someone" : ""
      }${this.#rooms.size > 0 ? `, ${this.#rooms.size} room(s)` : ", all joined rooms"})`,
    );

    ctx.askRouter.registerSender("matrix", (sessionId, text) => this.send(sessionId, text));
    this.#running = true;
    this.#live = true;
    this.#error = undefined;
    void this.#loop();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("matrix");
  }

  health(): ConnectorHealth {
    return this.#live ? { live: true } : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseMatrixSession(sessionId);
    if (!target) return;
    for (const part of formatForChat(text, MATRIX_MAX)) {
      // The transaction id makes a retry idempotent — the homeserver treats a
      // repeat of the same id as the same message rather than a second one.
      const txn = `cinderpaw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await this.#api(
        "PUT",
        `/_matrix/client/v3/rooms/${encodeURIComponent(target.roomId)}/send/m.room.message/${txn}`,
        { msgtype: "m.text", body: part },
      );
    }
  }

  /**
   * A file into the room behind `sessionId`.
   *
   * Two steps, both Matrix's: the bytes go to the media repository, which
   * answers with an `mxc://` URI, and then an ordinary room event points at
   * it. The event carries `msgtype: m.image`/`m.video`/`m.audio` when the MIME
   * type says so, because a client shows those inline and shows `m.file` as a
   * grey download row — same bytes, and the difference is whether the person
   * sees the picture they asked for.
   *
   * No size check here: a homeserver's limit is its own (`m.upload.size`),
   * admins change it, and guessing 50 MB would refuse files a server would
   * have taken. The upload answers with its own refusal and that sentence is
   * what the person gets.
   */
  async sendFile(sessionId: string, file: OutboundFile): Promise<void> {
    const target = parseMatrixSession(sessionId);
    if (!target) throw new Error("Matrix: that conversation is not a room I can post in.");
    const mime = mimeForName(file.name);

    const upload = await fetch(
      `${this.#homeserver}/_matrix/media/v3/upload?filename=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": mime },
        body: Buffer.from(file.data),
      },
    );
    if (!upload.ok) {
      const why = ((await upload.json().catch(() => ({}))) as { error?: string }).error;
      throw new Error(
        upload.status === 413
          ? `"${file.name}" is larger than this homeserver accepts.`
          : `Matrix refused the upload: ${why ?? `HTTP ${upload.status}`}`,
      );
    }
    const { content_uri: url } = (await upload.json()) as { content_uri?: string };
    if (!url) throw new Error("Matrix accepted the upload but returned no media URI.");

    const kind = mime.split("/")[0];
    const msgtype =
      kind === "image" ? "m.image" : kind === "video" ? "m.video" : kind === "audio" ? "m.audio" : "m.file";
    const txn = `cinderpaw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await this.#api(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(target.roomId)}/send/m.room.message/${txn}`,
      {
        msgtype,
        // `body` is what a client without rendering shows, `filename` is the
        // name it saves under. Same string when there is no caption, so the
        // file never arrives nameless.
        body: file.caption.trim() || file.name,
        filename: file.name,
        url,
        info: { mimetype: mime, size: file.data.byteLength },
      },
    );
    if (!res.ok) {
      const why = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      throw new Error(`Matrix took the file but would not post it: ${why ?? `HTTP ${res.status}`}`);
    }
  }

  #api(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.#homeserver}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async #loop(): Promise<void> {
    let backoffMs = 1000;
    while (this.#running) {
      const roundTripStart = Date.now();
      try {
        const qs = new URLSearchParams({ timeout: String(SYNC_TIMEOUT_MS) });
        if (this.#since) qs.set("since", this.#since);
        const res = await this.#api("GET", `/_matrix/client/v3/sync?${qs.toString()}`);
        if (!res.ok) {
          // A rejected token will never fix itself. Say so and stop, rather
          // than retrying forever behind a green light.
          if (res.status === 401 || res.status === 403) {
            this.#live = false;
            this.#error = "the homeserver rejected the access token — reconnect this account";
            this.#ctx?.log(`matrix: ${this.#error}`);
            this.#running = false;
            return;
          }
          throw new Error(`sync returned HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          next_batch?: string;
          rooms?: { join?: Record<string, { timeline?: { events?: MatrixEvent[] } }> };
        };
        const first = this.#since === undefined;
        this.#since = data.next_batch;
        this.#live = true;
        this.#error = undefined;
        backoffMs = 1000;
        // The first sync returns backlog. Answering a week of old messages at
        // once is the worst possible first impression, so it is only used to
        // establish the cursor.
        if (!first) await this.#drain(data.rooms?.join ?? {});
        // A homeserver is supposed to hold `/sync` open for `timeout` before
        // answering empty. Not all of them do — a proxy, an old server or a
        // misconfigured one answers instantly, and then this loop is a hot
        // loop that pins a core and empties a laptop battery with nothing to
        // show for it. The floor costs nothing when the server behaves.
        const elapsed = Date.now() - roundTripStart;
        if (elapsed < MIN_SYNC_GAP_MS) {
          await new Promise((r) => setTimeout(r, MIN_SYNC_GAP_MS - elapsed));
        }
      } catch (e) {
        if (!this.#running) return;
        this.#error = String(e);
        this.#ctx?.log(`matrix: sync failed (${this.#error}), retrying in ${Math.round(backoffMs / 1000)}s`);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }

  async #drain(join: Record<string, { timeline?: { events?: MatrixEvent[] } }>): Promise<void> {
    for (const [roomId, room] of Object.entries(join)) {
      if (this.#rooms.size > 0 && !this.#rooms.has(roomId)) continue;
      for (const ev of room.timeline?.events ?? []) {
        if (ev.type !== "m.room.message") continue;
        if (ev.content?.msgtype !== "m.text") continue;
        const sender = ev.sender ?? "";
        if (!sender || sender === this.#selfId) continue;
        const text = (ev.content.body ?? "").trim();
        if (!text) continue;
        // Not awaited: a turn can be waiting on this person's NEXT message (an
        // ask_user question, an approval), and that message only arrives through
        // the next poll. Awaiting here left every such question unanswered until it
        // timed out. Turns in one session still run in order: AgentLoop queues them.
        void this.#handle(roomId, sender, text, ev.event_id ?? "").catch((e) =>
          this.#ctx?.log(`matrix: message error: ${String(e)}`),
        );
      }
    }
  }

  async #handle(roomId: string, sender: string, text: string, eventId: string): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    ctx.onSender?.(sender, sender);
    if (!this.#allow.has(sender)) {
      ctx.log(`matrix: ignored message from non-allowlisted ${sender}`);
      return;
    }
    const sessionId = matrixSessionId(roomId, sender);

    // Before the ask-router, same order as every other connector: a slash
    // command is a command even while a question is pending.
    const command = await runChatCommand(ctx.agent, sessionId, text);
    if (command) {
      await this.send(sessionId, command);
      return;
    }
    // A reply to a pending ask_user question answers it — no agent turn.
    if (ctx.askRouter.handleInbound(sessionId, text)) return;

    if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
    ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("Matrix"));

    try {
      const { reply } = await runAgent(ctx.agent, sessionId, `[user:${sender}] ${text}`, `matrix-${eventId}`);
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`matrix: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e));
    }
  }
}

registerTransport("matrix", () => new MatrixConnector());
