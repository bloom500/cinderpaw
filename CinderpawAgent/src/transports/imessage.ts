/**
 * iMessage — macOS only, through the `imsg` bridge, and it says so.
 *
 * Apple has no bot API. Everything that reads Messages reads the local
 * `chat.db` and sends through Messages.app, which is what `imsg`
 * (github.com/steipete/imsg) does; `imsg rpc` exposes it as JSON-RPC 2.0 on
 * stdin/stdout, one object per line. We spawn one child, ask `status`, then
 * `watch.subscribe` and answer `message` notifications; replies go by `send`
 * into the same chat. Nothing leaves the machine except through Apple.
 *
 * Signal's shape, one step further: Signal needed a bridge installed; this
 * needs a bridge AND a Mac AND two permissions (Full Disk Access for the
 * database, Automation for Messages.app). Each of those is a sentence on the
 * user's screen at start(), because every one of them looks identical from
 * the outside: a connector that is on and never hears anything.
 *
 * Written on Windows against the documented protocol and a fake bridge; not
 * yet run against a real Mac. The card stays coming_soon until it is.
 *
 * ponytail: text only, no attachments, no tapbacks, no group creation.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  connectorErrorMessage,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief, formatForChat } from "./chat-format.ts";
import { registerTransport, type ConnectorContext, type LiveConnector } from "./registry.ts";

const IMESSAGE_MAX = 4000;
const RPC_TIMEOUT_MS = 15_000;

export function imessageSessionId(chatId: number | string, sender: string): string {
  return `imessage:${chatId}:${sender}`;
}

export function parseImessageSession(sessionId: string): { chatId: string; sender: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[0] !== "imessage" || !parts[1] || !parts[2]) return null;
  return { chatId: parts[1], sender: parts[2] };
}

/**
 * The bridge as this transport sees it: lines in, lines out, and a way to
 * end it. `spawn` is the real one; the test hands in a fake.
 */
export interface Bridge {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

export function spawnImsg(cliPath: string): Bridge {
  const child = spawn(cliPath, ["rpc"], { stdio: ["pipe", "pipe", "pipe"] });
  const rl = createInterface({ input: child.stdout! });
  return {
    write: (line) => child.stdin!.write(line + "\n"),
    onLine: (cb) => rl.on("line", cb),
    onExit: (cb) => child.on("exit", (code) => cb(code)),
    kill: () => child.kill(),
  };
}

interface ImsgMessage {
  id?: number;
  chat_id?: number;
  sender?: string;
  text?: string;
  is_from_me?: boolean;
}

interface RpcReply {
  id?: string | number | null;
  method?: string;
  params?: { message?: ImsgMessage };
  result?: unknown;
  error?: { code?: number; message?: string };
}

export class ImessageConnector implements LiveConnector {
  #ctx: ConnectorContext | null = null;
  #bridge: Bridge | null = null;
  #live = false;
  #error: string | undefined;
  #allow = new Set<string>();
  #chats = new Set<string>();
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #seen = new Set<number>();
  readonly #spawn: (cliPath: string) => Bridge;
  readonly #platform: string;

  constructor(opts: { spawn?: (cliPath: string) => Bridge; platform?: string } = {}) {
    this.#spawn = opts.spawn ?? spawnImsg;
    this.#platform = opts.platform ?? process.platform;
  }

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    if (this.#platform !== "darwin") {
      throw new Error(
        "imessage: only works on a Mac. Messages lives in Apple's own database and only Messages.app can send, " +
          "so this connector has to run on the Mac that is signed into iMessage. Enable it there.",
      );
    }
    const cli = (ctx.row.metadata?.IMESSAGE_CLI_PATH ?? ctx.secrets.IMESSAGE_CLI_PATH ?? "imsg").trim() || "imsg";

    let bridge: Bridge;
    try {
      bridge = this.#spawn(cli);
    } catch (e) {
      throw new Error(imsgMissingMessage(cli, String(e)));
    }
    this.#bridge = bridge;
    bridge.onLine((line) => this.#onLine(line));
    bridge.onExit((code) => {
      if (!this.#live) return;
      this.#live = false;
      this.#error = `imessage: the imsg bridge exited (code ${code ?? "?"}). Enable the connector again to restart it.`;
      ctx.log(this.#error);
      for (const p of this.#pending.values()) p.reject(new Error(this.#error));
      this.#pending.clear();
    });

    // `status` is the readiness snapshot: it says whether the database can
    // be read (Full Disk Access) before a single message is waited for.
    let status: { db_ready?: boolean; database?: { ready?: boolean }; ready?: boolean };
    try {
      status = (await this.#call("status", {})) as typeof status;
    } catch (e) {
      bridge.kill();
      throw new Error(imsgMissingMessage(cli, String(e)));
    }
    const dbReady = status.db_ready ?? status.database?.ready ?? status.ready ?? true;
    if (!dbReady) {
      bridge.kill();
      throw new Error(
        "imessage: imsg is installed but cannot read the Messages database. Give your terminal (or Cinderpaw) " +
          "Full Disk Access in System Settings → Privacy & Security, then enable this connector again.",
      );
    }

    await this.#call("watch.subscribe", {});

    this.#allow = new Set((ctx.row.allowlist ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean));
    this.#chats = new Set((ctx.row.channels ?? []).map((s) => s.trim()).filter(Boolean));
    ctx.log(
      `imessage: bridge ${cli} answering (${
        this.#allow.size === 0
          ? "0 allowed — NOBODY CAN REACH IT: the allowlist is empty, so every message is ignored. " +
            "Add phone numbers or Apple ID emails to the allowlist to make it answer."
          : `${this.#allow.size} allowed`
      })`,
    );

    ctx.askRouter.registerSender("imessage", (sessionId, text) => this.send(sessionId, text));
    this.#live = true;
    this.#error = undefined;
  }

  async stop(): Promise<void> {
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("imessage");
    this.#bridge?.kill();
    this.#bridge = null;
  }

  health(): ConnectorHealth {
    return this.#live
      ? { live: true }
      : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseImessageSession(sessionId);
    if (!target) return;
    for (const part of formatForChat(text, IMESSAGE_MAX)) {
      await this.#call("send", { chat_id: Number(target.chatId), text: part });
    }
  }

  /** One JSON-RPC request, matched to its reply by id. */
  #call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const bridge = this.#bridge;
    if (!bridge) return Promise.reject(new Error("imessage: bridge not running"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`imessage: imsg did not answer ${method} within ${RPC_TIMEOUT_MS / 1000}s`));
      }, RPC_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      bridge.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  #onLine(line: string): void {
    let msg: RpcReply;
    try {
      msg = JSON.parse(line) as RpcReply;
    } catch {
      return; // progress chatter, not protocol
    }
    if (msg.id !== undefined && msg.id !== null && this.#pending.has(Number(msg.id))) {
      const p = this.#pending.get(Number(msg.id))!;
      this.#pending.delete(Number(msg.id));
      if (msg.error) p.reject(new Error(`imessage: imsg answered ${msg.error.code ?? "?"}: ${msg.error.message ?? ""}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "message" && msg.params?.message) void this.#onMessage(msg.params.message);
  }

  async #onMessage(m: ImsgMessage): Promise<void> {
    const text = m.text?.trim();
    const sender = m.sender?.trim().toLowerCase();
    if (!text || !sender || m.chat_id === undefined) return;
    if (m.is_from_me) return;
    if (typeof m.id === "number") {
      if (this.#seen.has(m.id)) return;
      this.#seen.add(m.id);
      if (this.#seen.size > 2000) this.#seen.delete(this.#seen.values().next().value!);
    }
    const chatId = String(m.chat_id);
    if (this.#chats.size > 0 && !this.#chats.has(chatId)) return;

    const ctx = this.#ctx;
    if (!ctx) return;
    if (!this.#allow.has(sender)) {
      ctx.log(`imessage: ignored a message from non-allowlisted ${sender} (chat ${chatId})`);
      return;
    }
    const sessionId = imessageSessionId(chatId, sender);
    try {
      const command = await runChatCommand(ctx.agent, sessionId, text);
      if (command) {
        await this.send(sessionId, command);
        return;
      }
      if (ctx.askRouter.handleInbound(sessionId, text)) return;

      if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
      ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("iMessage"));

      const { reply } = await runAgent(ctx.agent, sessionId, `[user:${sender}] ${text}`, `imessage-${m.id ?? Date.now()}`);
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`imessage: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e)).catch(() => {});
    }
  }
}

/** What to tell someone whose bridge did not start or did not answer. */
export function imsgMissingMessage(cli: string, why: string): string {
  return (
    `imessage: could not start the imsg bridge at "${cli}" (${why}). Install it with ` +
    "`brew install steipete/tap/imsg`, or set IMESSAGE_CLI_PATH to where it is, then enable this connector again."
  );
}

/**
 * Registered by name so boot.ts can turn it on with one import the day a
 * Mac has proven it. Until then the catalog card says coming_soon, and a
 * transport that registered itself now would make the catalog/transport pin
 * test call that card a lie, correctly.
 */
export function registerImessage(): void {
  registerTransport("imessage", () => new ImessageConnector());
}
