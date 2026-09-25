/**
 * Nextcloud Talk — self-hosted, and reachable from a machine with no address.
 *
 * OpenClaw connects to Talk as a **webhook bot**: you register a bot with a
 * shared secret and Nextcloud POSTs to a URL you own. That is the right design
 * for a server, and it is unreachable for the person this connector is for.
 * Someone self-hosting Nextcloud at home behind a router has no public URL for
 * Cinderpaw, no certificate, and no way to get one without a tunnel. A bot
 * connector that needs an inbound address is a card that can never go green on
 * their machine.
 *
 * So this pairs as a USER instead, with an app password, and long-polls the
 * chat API the way the web client does. Nothing inbound, nothing to expose,
 * and the same credential model as Matrix and Mattermost: an instance address
 * plus a token that is not a password and can be revoked on its own.
 *
 * No dependency: Talk's OCS API is JSON over HTTP and `fetch` is enough.
 *
 * ponytail: text only, and no room creation. The agent answers in rooms the
 * user has already joined, which is the same promise the other connectors make.
 */

import {
  connectorErrorMessage,
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

/**
 * Talk stores a chat message as a Nextcloud comment, and comments are capped
 * at 32000 characters server-side. 8000 keeps a long answer readable in the
 * client, which wraps poorly past a few screens.
 */
const TALK_MAX = 8000;

/**
 * Nextcloud caps `lookIntoFuture` at 30 seconds and answers 304 when nothing
 * arrived. The fetch timeout is longer on purpose, so a slow but healthy long
 * poll is never mistaken for a dead server.
 */
const POLL_SECONDS = 30;
const POLL_TIMEOUT_MS = (POLL_SECONDS + 15) * 1000;

/** How often the room list is re-read, so a newly joined room starts working
 *  without restarting the connector. */
const ROOM_REFRESH_MS = 60_000;

export function nextcloudTalkSessionId(roomToken: string, actorId: string): string {
  return `nextcloud-talk:${roomToken}:${actorId}`;
}

export function parseNextcloudTalkSession(
  sessionId: string,
): { roomToken: string; actorId: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[0] !== "nextcloud-talk") return null;
  return { roomToken: parts[1]!, actorId: parts[2]! };
}

/**
 * People paste what the browser bar shows them, which is very often
 * `https://cloud.example.com/index.php/apps/files/` and not the base URL the
 * API needs. Trimming the trailing path here is the difference between a
 * working connector and a 404 that reads like the server is down.
 */
export function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, "");
  if (!trimmed) throw new Error("nextcloud-talk: no server address");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(
      `nextcloud-talk: "${raw}" is not a web address — it should look like https://cloud.example.com`,
    );
  }
  // Everything from /index.php or /apps onwards is the web UI, not the API root.
  const path = url.pathname.replace(/\/(index\.php|apps|settings)(\/.*)?$/i, "").replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

interface TalkRoom {
  token: string;
  displayName?: string;
  lastMessage?: { id?: number };
}

interface TalkMessage {
  id: number;
  actorType?: string;
  actorId?: string;
  actorDisplayName?: string;
  message?: string;
  messageType?: string;
}

export class NextcloudTalkConnector implements LiveConnector {
  #base = "";
  #auth = "";
  #self = "";
  #ctx: ConnectorContext | null = null;
  #running = false;
  #live = false;
  #error: string | undefined;
  #allow = new Set<string>();
  #rooms = new Set<string>();
  /** Rooms with a poll loop already running, so a refresh does not start a
   *  second one for the same room. */
  #polling = new Set<string>();
  /** Per room, the last message id seen. Talk returns it in a header. */
  #lastSeen = new Map<string, number>();
  #roomTimer: ReturnType<typeof setInterval> | null = null;

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    // The address is configuration, not a credential — same call as Matrix.
    const rawBase = ctx.row.metadata?.NEXTCLOUD_TALK_URL ?? ctx.secrets.NEXTCLOUD_TALK_URL ?? "";
    const user = (ctx.row.metadata?.NEXTCLOUD_TALK_USER ?? ctx.secrets.NEXTCLOUD_TALK_USER ?? "").trim();
    const password = (ctx.secrets.NEXTCLOUD_TALK_APP_PASSWORD ?? "").trim();
    if (!rawBase.trim()) {
      throw new Error(
        "nextcloud-talk: no server address — Cinderpaw cannot tell which Nextcloud to connect to (expected NEXTCLOUD_TALK_URL, e.g. https://cloud.example.com)",
      );
    }
    if (!user) {
      throw new Error("nextcloud-talk: no username (expected NEXTCLOUD_TALK_USER)");
    }
    if (!password) {
      throw new Error(
        "nextcloud-talk: no app password (expected secrets.NEXTCLOUD_TALK_APP_PASSWORD — create one under Settings, Security, Devices & sessions; do not use your login password)",
      );
    }
    this.#base = normaliseBaseUrl(rawBase);
    this.#auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

    // Verify the credential and learn our own actor id before claiming to be
    // live: without the id the agent answers its own messages forever, and a
    // wrong app password would otherwise look like a room nobody writes in.
    const me = await this.#api("GET", "/ocs/v2.php/cloud/user");
    if (!me.ok) {
      throw new Error(
        me.status === 401
          ? "nextcloud-talk: the server rejected the app password — create a fresh one under Settings, Security, Devices & sessions"
          : me.status === 404
            ? `nextcloud-talk: no Nextcloud API at ${this.#base} — check the address, it should be the site root and not a page inside it`
            : `nextcloud-talk: the server answered HTTP ${me.status}`,
      );
    }
    this.#self = ocsData<{ id?: string }>(await me.json())?.id ?? user;

    this.#allow = new Set((ctx.row.allowlist ?? []).map((s) => s.trim()).filter(Boolean));
    // `channels` narrows to specific rooms; empty means every room the user is
    // already in, which is what someone enabling this expects.
    this.#rooms = new Set((ctx.row.channels ?? []).map((s) => s.trim()).filter(Boolean));

    ctx.askRouter.registerSender("nextcloud-talk", (sessionId, text) => this.send(sessionId, text));
    this.#running = true;
    this.#live = true;
    this.#error = undefined;
    ctx.log(
      `nextcloud-talk: connected to ${this.#base} as ${this.#self} (${
        this.#allow.size === 0
          ? "0 allowed — NOBODY CAN REACH IT: the allowlist is empty, so every message is ignored. " +
            "Add Nextcloud usernames to the allowlist to make it answer."
          : `${this.#allow.size} allowed`
      })`,
    );

    await this.#refreshRooms();
    this.#roomTimer = setInterval(() => void this.#refreshRooms(), ROOM_REFRESH_MS);
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("nextcloud-talk");
    if (this.#roomTimer) clearInterval(this.#roomTimer);
    this.#roomTimer = null;
    this.#polling.clear();
    this.#lastSeen.clear();
  }

  health(): ConnectorHealth {
    return this.#live
      ? { live: true }
      : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseNextcloudTalkSession(sessionId);
    if (!target) return;
    for (const part of formatForChat(text, TALK_MAX)) {
      await this.#api("POST", `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(target.roomToken)}`, {
        message: part,
      });
    }
  }

  /**
   * A file into the room behind `sessionId`.
   *
   * Talk has no "post these bytes" call. A file in a Nextcloud chat is a
   * SHARE of a file that lives in the sender's own Files: it is uploaded over
   * WebDAV into the bot user's `Talk/` folder (the same folder the web client
   * uses, created on demand), and then shared to the room. So the file stays
   * in the bot account afterwards, visible to whoever can see that account -
   * that is how the platform works, not something we can hide, and it is why
   * the setup steps ask for a SEPARATE Nextcloud user.
   *
   * The name is made unique with a timestamp: a second upload of `report.pdf`
   * would otherwise overwrite the first, and the older share in the chat
   * would silently start pointing at the newer file.
   */
  async sendFile(sessionId: string, file: OutboundFile): Promise<void> {
    const target = parseNextcloudTalkSession(sessionId);
    if (!target) throw new Error("Nextcloud Talk: that conversation is not a room I can post in.");

    const dav = `${this.#base}/remote.php/dav/files/${encodeURIComponent(this.#self)}`;
    // MKCOL is 405 when the folder is already there, which is the normal case.
    await fetch(`${dav}/Talk`, {
      method: "MKCOL",
      headers: { Authorization: this.#auth },
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    }).catch(() => undefined);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dot = file.name.lastIndexOf(".");
    const unique = dot > 0 ? `${file.name.slice(0, dot)}-${stamp}${file.name.slice(dot)}` : `${file.name}-${stamp}`;

    const put = await fetch(`${dav}/Talk/${encodeURIComponent(unique)}`, {
      method: "PUT",
      headers: { Authorization: this.#auth },
      body: Buffer.from(file.data),
      signal: AbortSignal.timeout(120_000),
    });
    if (!put.ok) {
      throw new Error(
        put.status === 413
          ? `"${file.name}" is larger than this Nextcloud accepts.`
          : put.status === 507
            ? `Nextcloud has no space left in the ${this.#self} account for "${file.name}".`
            : `Nextcloud refused the upload (HTTP ${put.status}).`,
      );
    }

    // shareType 10 is "Talk conversation"; shareWith is the room token.
    const share = await fetch(`${this.#base}/ocs/v2.php/apps/files_sharing/api/v1/shares`, {
      method: "POST",
      headers: {
        Authorization: this.#auth,
        "OCS-APIRequest": "true",
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ shareType: 10, shareWith: target.roomToken, path: `/Talk/${unique}` }),
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
    if (!share.ok) {
      throw new Error(
        `Nextcloud took the file but would not put it in the conversation (HTTP ${share.status}). ` +
          `It is in ${this.#self}'s Talk folder as "${unique}".`,
      );
    }
    if (file.caption.trim()) await this.send(sessionId, file.caption);
  }

  #api(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.#base}${path}`, {
      method,
      headers: {
        Authorization: this.#auth,
        // Without this header Nextcloud answers every OCS call with 412.
        "OCS-APIRequest": "true",
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
    });
  }

  /** Read the room list, and start a poll loop for any room not polled yet. */
  async #refreshRooms(): Promise<void> {
    if (!this.#running) return;
    try {
      const res = await this.#api("GET", "/ocs/v2.php/apps/spreed/api/v4/room");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rooms = ocsData<TalkRoom[]>(await res.json()) ?? [];
      this.#live = true;
      this.#error = undefined;
      for (const room of rooms) {
        if (!room.token) continue;
        if (this.#rooms.size > 0 && !this.#rooms.has(room.token)) continue;
        if (this.#polling.has(room.token)) continue;
        // Start from the room's current last message, not from zero. Starting
        // at zero replays the entire room history and the agent answers
        // months of conversation at once.
        this.#lastSeen.set(room.token, room.lastMessage?.id ?? 0);
        this.#polling.add(room.token);
        void this.#pollRoom(room.token);
      }
    } catch (e) {
      this.#live = false;
      this.#error = `could not read the room list: ${String(e)}`;
      this.#ctx?.log(`nextcloud-talk: ${this.#error}`);
    }
  }

  /** One long-poll loop per room. Runs until `stop()`, survives its errors. */
  async #pollRoom(roomToken: string, backoffMs = 1000): Promise<void> {
    while (this.#running) {
      try {
        const lastKnown = this.#lastSeen.get(roomToken) ?? 0;
        const res = await this.#api(
          "GET",
          `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(roomToken)}` +
            `?lookIntoFuture=1&includeLastKnown=0&timeout=${POLL_SECONDS}&lastKnownMessageId=${lastKnown}`,
        );

        // 304 is the normal answer to a quiet room: the long poll expired with
        // nothing new. It is not an error and must not trigger a backoff.
        if (res.status === 304) {
          this.#live = true;
          backoffMs = 1000;
          continue;
        }
        if (res.status === 401) {
          // A revoked app password never resolves by retrying, and retrying it
          // forever is how an account ends up rate-limited or locked.
          this.#running = false;
          this.#live = false;
          this.#error = "the app password was revoked — create a new one and re-enable this connector";
          this.#ctx?.log(`nextcloud-talk: ${this.#error}`);
          return;
        }
        if (res.status === 404) {
          // The room is gone or we were removed from it. Stop this loop only,
          // not the connector.
          this.#polling.delete(roomToken);
          this.#ctx?.log(`nextcloud-talk: stopped following ${roomToken} (the room is gone)`);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        // Talk reports the new cursor in a header, and it is authoritative:
        // computing it from the messages misses the system events Talk counts
        // but does not return, and the loop then re-reads the same window.
        const given = Number(res.headers.get("X-Chat-Last-Given") ?? "");
        const messages = ocsData<TalkMessage[]>(await res.json()) ?? [];
        this.#live = true;
        this.#error = undefined;
        backoffMs = 1000;

        if (Number.isFinite(given) && given > 0) {
          this.#lastSeen.set(roomToken, given);
        } else if (messages.length > 0) {
          this.#lastSeen.set(roomToken, Math.max(...messages.map((m) => m.id)));
        }

        for (const message of messages) {
          // Not awaited: a turn can be waiting on this person's NEXT message (an
          // ask_user question, an approval), and that message only arrives through
          // the next poll. Awaiting here left every such question unanswered until it
          // timed out. Turns in one session still run in order: AgentLoop queues them.
          void this.#onMessage(roomToken, message).catch((e) =>
            this.#ctx?.log(`nextcloud-talk: message error: ${String(e)}`),
          );
        }
      } catch (e) {
        if (!this.#running) return;
        this.#live = false;
        this.#error = String(e);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }

  async #onMessage(roomToken: string, message: TalkMessage): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    // `system` messages are joins, leaves and calls; `command` is a slash
    // command Talk handled itself. Neither is something a person wrote to us.
    if (message.messageType && message.messageType !== "comment") return;
    if (message.actorType !== "users") return;
    const actorId = (message.actorId ?? "").trim();
    const text = (message.message ?? "").trim();
    if (!actorId || !text) return;
    if (actorId === this.#self) return;

    ctx.onSender?.(actorId, actorId);
    if (!this.#allow.has(actorId)) {
      ctx.log(`nextcloud-talk: ignored message from non-allowlisted ${actorId}`);
      return;
    }

    const sessionId = nextcloudTalkSessionId(roomToken, actorId);

    const command = await runChatCommand(ctx.agent, sessionId, text);
    if (command) {
      await this.send(sessionId, command);
      return;
    }
    if (ctx.askRouter.handleInbound(sessionId, text)) return;

    if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
    ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("Nextcloud Talk"));

    try {
      const { reply } = await runAgent(
        ctx.agent,
        sessionId,
        `[user:${actorId}] ${text}`,
        `nextcloud-talk-${message.id}`,
      );
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`nextcloud-talk: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e));
    }
  }
}

/**
 * Every OCS response wraps its payload in `{ ocs: { meta, data } }`. Reaching
 * for `.data` without checking is how a 200 carrying an OCS-level failure gets
 * read as an empty list and then reported as a quiet room.
 */
export function ocsData<T>(body: unknown): T | null {
  if (!body || typeof body !== "object") return null;
  const ocs = (body as { ocs?: { data?: unknown } }).ocs;
  if (!ocs || typeof ocs !== "object") return null;
  return (ocs.data ?? null) as T | null;
}

registerTransport("nextcloud-talk", () => new NextcloudTalkConnector());
