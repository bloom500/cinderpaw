/**
 * Zalo, as the user's own PERSONAL account — and the warning that comes with it.
 *
 * `zalo.ts` is the official Bot API. This is different: it logs into a
 * person's own Zalo account by scanning a QR with the phone, through `zca-js`,
 * a community re-implementation of the private client protocol that Zalo
 * does not sanction. Zalo may suspend an account it decides is automated.
 * The card says that before the first scan, and so does this log, because
 * nobody should learn it from a locked account.
 *
 * Pairing is WhatsApp's shape: a QR on first enable, a session saved under
 * ~/.cinderpaw so restarts do not ask again. The QR is a PNG, not a text
 * payload like WhatsApp's, so it is written to a file, opened with the OS
 * image viewer where that works, and the path is put on the card until the
 * phone confirms.
 *
 * ponytail: text only, DMs and named groups, no media, no reactions.
 */

import { spawn } from "node:child_process";
import { chmod, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cinderpawHome } from "../config.ts";
import {
  connectorErrorMessage,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief, formatForChat } from "./chat-format.ts";
import { registerTransport, type ConnectorContext, type LiveConnector } from "./registry.ts";

const ZALO_MAX = 2000;
const ThreadUser = 0;
const ThreadGroup = 1;

export const ZALOUSER_WARNING =
  "zalouser: this signs in to your PERSONAL Zalo account through an unofficial client. " +
  "Zalo may suspend accounts it considers automated. Use a spare account if that would hurt.";

export function zalouserSessionId(threadId: string, userId: string): string {
  return `zalouser:${threadId}:${userId}`;
}

export function parseZalouserSession(sessionId: string): { threadId: string; userId: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[0] !== "zalouser" || !parts[1] || !parts[2]) return null;
  return { threadId: parts[1], userId: parts[2] };
}

/** The slice of zca-js this transport touches, so the test can fake it. */
export interface ZaloApi {
  listener: {
    on(event: "message", cb: (m: ZaloMessage) => void): unknown;
    on(event: "error", cb: (e: unknown) => void): unknown;
    on(event: "closed", cb: (code: number, reason: string) => void): unknown;
    start(opts?: { retryOnClose?: boolean }): void;
    stop(): void;
  };
  sendMessage(text: string, threadId: string, type: number): Promise<unknown>;
  getOwnId(): string | number;
  getCookie(): { toJSON(): { cookies?: unknown[] } };
}
export interface ZaloMessage {
  type: number;
  threadId: string;
  isSelf: boolean;
  data: { msgId?: string; uidFrom?: string; idTo?: string; content?: unknown; dName?: string };
}
export interface ZaloClient {
  /** Restore a saved session. */
  login(creds: SavedSession): Promise<ZaloApi>;
  /** First pairing: the callback receives the QR image and, later, the credentials. */
  loginQR(cb: (ev: { type: number; data: unknown }) => void): Promise<ZaloApi>;
}
interface SavedSession {
  imei: string;
  cookie: unknown;
  userAgent: string;
}

export async function loadZcaClient(): Promise<ZaloClient> {
  const mod = (await import("zca-js")) as unknown as { Zalo: new (o?: { logging?: boolean; selfListen?: boolean }) => { login(c: unknown): Promise<unknown>; loginQR(o?: unknown, cb?: unknown): Promise<unknown> } };
  const zalo = new mod.Zalo({ logging: false, selfListen: false });
  return {
    login: (creds) => zalo.login(creds) as Promise<ZaloApi>,
    loginQR: (cb) => zalo.loginQR(undefined, cb) as Promise<ZaloApi>,
  };
}

const sessionPath = () => join(cinderpawHome(), "zalouser-session.json");
const qrPath = () => join(cinderpawHome(), "zalouser-qr.png");

/** Best effort: show the QR in the OS image viewer. Nothing depends on it. */
function openImage(path: string, platform = process.platform): void {
  try {
    const cmd = platform === "win32" ? ["cmd", ["/c", "start", "", path]] as const
      : platform === "darwin" ? ["open", [path]] as const
      : ["xdg-open", [path]] as const;
    spawn(cmd[0], [...cmd[1]], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // no viewer: the path is on the card
  }
}

export class ZalouserConnector implements LiveConnector {
  #ctx: ConnectorContext | null = null;
  #api: ZaloApi | null = null;
  #live = false;
  #error: string | undefined;
  #allow = new Set<string>();
  #groups = new Set<string>();
  #seen = new Set<string>();
  readonly #client: () => Promise<ZaloClient>;
  readonly #open: (path: string) => void;

  constructor(opts: { client?: () => Promise<ZaloClient>; open?: (path: string) => void } = {}) {
    this.#client = opts.client ?? loadZcaClient;
    this.#open = opts.open ?? openImage;
  }

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    ctx.log(ZALOUSER_WARNING);
    const client = await this.#client();

    let api: ZaloApi | null = null;
    const saved = await readFile(sessionPath(), "utf8").then((s) => JSON.parse(s) as SavedSession).catch(() => null);
    if (saved) {
      try {
        api = await client.login(saved);
        ctx.log("zalouser: restored the saved session");
      } catch (e) {
        ctx.log(`zalouser: the saved session no longer works (${String(e)}); pairing again`);
        await unlink(sessionPath()).catch(() => {});
      }
    }
    if (!api) {
      let creds: SavedSession | null = null;
      // The QR arrives inside the callback while loginQR is still pending,
      // and the phone may take minutes; the card carries the path meanwhile.
      this.#error = `zalouser: waiting for you to scan the QR code (${qrPath()}) with Zalo on your phone: Settings → Linked devices`;
      api = await client.loginQR((ev) => {
        if (ev.type === 0) {
          const image = String((ev.data as { image?: string }).image ?? "").replace(/^data:image\/png;base64,/, "");
          void writeFile(qrPath(), Buffer.from(image, "base64"))
            .then(() => {
              ctx.log(`zalouser: scan the QR at ${qrPath()} with Zalo on your phone (Settings → Linked devices)`);
              this.#open(qrPath());
            })
            .catch((e: unknown) => ctx.log(`zalouser: could not write the QR image: ${String(e)}`));
        } else if (ev.type === 3) {
          this.#error = "zalouser: the QR login was declined on the phone";
        } else if (ev.type === 4) {
          const d = ev.data as SavedSession;
          creds = { imei: d.imei, cookie: d.cookie, userAgent: d.userAgent };
        }
      });
      await unlink(qrPath()).catch(() => {});
      if (creds) {
        await writeFile(sessionPath(), JSON.stringify(creds));
        await chmod(sessionPath(), 0o600).catch(() => {});
      }
      ctx.log("zalouser: paired, session saved");
    }
    this.#api = api;

    this.#allow = new Set((ctx.row.allowlist ?? []).map((s) => s.trim()).filter(Boolean));
    this.#groups = new Set((ctx.row.channels ?? []).map((s) => s.trim()).filter(Boolean));
    ctx.log(
      `zalouser: online as ${String(api.getOwnId())} (${
        this.#allow.size === 0
          ? "0 allowed — NOBODY CAN REACH IT: the allowlist is empty, so every message is ignored. " +
            "Add Zalo user ids (printed here when someone writes) to the allowlist to make it answer."
          : `${this.#allow.size} allowed`
      })`,
    );

    api.listener.on("message", (m) => void this.#onMessage(m));
    api.listener.on("error", (e) => {
      this.#live = false;
      this.#error = `zalouser: listener error: ${String(e)}`;
      ctx.log(this.#error);
    });
    api.listener.on("closed", (code, reason) => {
      if (!this.#live) return;
      this.#live = false;
      this.#error = `zalouser: Zalo closed the connection (${code}: ${reason || "no reason"}). Re-enable the connector to reconnect.`;
      ctx.log(this.#error);
    });
    api.listener.start({ retryOnClose: true });

    ctx.askRouter.registerSender("zalouser", (sessionId, text) => this.send(sessionId, text));
    this.#live = true;
    this.#error = undefined;
  }

  async stop(): Promise<void> {
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("zalouser");
    try { this.#api?.listener.stop(); } catch { /* already stopped */ }
    this.#api = null;
  }

  health(): ConnectorHealth {
    return this.#live
      ? { live: true }
      : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseZalouserSession(sessionId);
    if (!target || !this.#api) return;
    const type = this.#groups.has(target.threadId) ? ThreadGroup : ThreadUser;
    for (const part of formatForChat(text, ZALO_MAX)) {
      await this.#api.sendMessage(part, target.threadId, type);
    }
  }

  async #onMessage(m: ZaloMessage): Promise<void> {
    if (m.isSelf) return;
    const text = typeof m.data.content === "string" ? m.data.content.trim() : "";
    const userId = m.data.uidFrom?.trim();
    if (!text || !userId) return;
    const isGroup = m.type === ThreadGroup;
    const threadId = isGroup ? (m.data.idTo ?? m.threadId) : userId;
    if (isGroup && !this.#groups.has(threadId)) return;
    const key = m.data.msgId ?? "";
    if (key) {
      if (this.#seen.has(key)) return;
      this.#seen.add(key);
      if (this.#seen.size > 2000) this.#seen.delete(this.#seen.values().next().value!);
    }
    const ctx = this.#ctx;
    if (!ctx) return;
    ctx.onSender?.(userId, userId);
    if (!this.#allow.has(userId)) {
      ctx.log(`zalouser: ignored a message from non-allowlisted ${userId}${m.data.dName ? ` (${m.data.dName})` : ""}`);
      return;
    }
    const sessionId = zalouserSessionId(threadId, userId);
    try {
      const command = await runChatCommand(ctx.agent, sessionId, text);
      if (command) {
        await this.send(sessionId, command);
        return;
      }
      if (ctx.askRouter.handleInbound(sessionId, text)) return;

      if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
      ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("Zalo"));

      const { reply } = await runAgent(ctx.agent, sessionId, `[user:${userId}] ${text}`, `zalouser-${key || Date.now()}`);
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`zalouser: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e)).catch(() => {});
    }
  }
}

registerTransport("zalouser", () => new ZalouserConnector());
