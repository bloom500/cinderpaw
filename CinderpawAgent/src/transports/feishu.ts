/**
 * Feishu / Lark — the enterprise one that needs no public address.
 *
 * Feishu (open.feishu.cn, mainland China) and Lark (open.larksuite.com, the
 * rest of the world) are the same product on two separate clouds. An app
 * created on one does not exist on the other.
 *
 * OpenClaw's connector is webhook-shaped, and `docs/openclaw-import.md` listed
 * Feishu among the ports blocked on an inbound URL for exactly that reason.
 * Reading the platform rather than the connector says otherwise: Feishu
 * supports a WebSocket "long connection" mode, where the app dials OUT and
 * events arrive on that socket. No public address, no certificate, no tunnel.
 * That is the whole reason this file exists, and it is why Feishu ships before
 * the five in `docs/decisions/2026-09-12-webhook-inbound.md`.
 *
 * The socket framing is proprietary, so this is the one transport here that
 * does not hand-roll its HTTP: `@larksuiteoapi/node-sdk` (MIT) owns the
 * handshake, the reconnect and the event decoding.
 * `scripts/openclaw/license-inventory.py` was re-run after adding it, and its
 * eleven transitive packages need no decision.
 *
 * **Which cloud, measured on 2026-09-12:** both hosts answer a bad app id with
 * `HTTP 200` and `{"code":10003,...}`. So `if (!res.ok)` is blind here in the
 * same way it is blind for Zalo, and a wrong-cloud app would otherwise look
 * like a connector that simply never receives anything. Nobody can be expected
 * to know which cloud their administrator created the app on, and a setting
 * nobody sets is the wrong answer, so `start()` asks BOTH and keeps the one
 * that returns `code: 0`. `FEISHU_DOMAIN` in metadata skips the probe.
 *
 * What is verified and what is not, said plainly because nobody here has a
 * Feishu tenant: the two hosts, the token endpoint, its envelope and the
 * 200-with-nonzero-code behaviour were probed directly, and `WSClient` and
 * `im.message.create` were checked against the installed SDK. The inbound
 * event shape follows the SDK's own `im.message.receive_v1` type and is NOT
 * confirmed against a live tenant, so it is read defensively: an unexpected
 * shape yields no message rather than a crash, and `ctx.log` says so.
 */

import { Client, Domain, EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";

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

/** The two clouds, in probe order. `host` is used by the probe; the SDK takes
 *  the enum. */
const CLOUDS = [
  { name: "feishu", host: "https://open.feishu.cn", domain: Domain.Feishu },
  { name: "lark", host: "https://open.larksuite.com", domain: Domain.Lark },
] as const;

type Cloud = (typeof CLOUDS)[number];

/** Feishu's own cap is far higher, but a wall of text is unreadable in a chat
 *  client and every other transport here splits at roughly this. */
const FEISHU_MAX = 4000;

/** Feishu's own limits, and they differ by door: 10 MB image, 30 MB file. */
const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024;

/** The platform's short list of file types; everything else is `stream`. */
export function feishuFileType(name: string): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "opus") return "opus";
  if (ext === "mp4") return "mp4";
  if (ext === "doc" || ext === "docx") return "doc";
  if (ext === "xls" || ext === "xlsx") return "xls";
  if (ext === "ppt" || ext === "pptx") return "ppt";
  return "stream";
}

const PROBE_TIMEOUT_MS = 15_000;

export function feishuSessionId(chatId: string, openId: string): string {
  return `feishu:${chatId}:${openId}`;
}

export function parseFeishuSession(sessionId: string): { chatId: string; openId: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[0] !== "feishu") return null;
  return { chatId: parts[1]!, openId: parts[2]! };
}

/**
 * Pull the plain text out of an `im.message.receive_v1` payload.
 *
 * `content` is a JSON *string*, not an object, and for a text message it is
 * `{"text":"..."}`. In a group the bot is addressed by an @-mention, which
 * arrives inside the text as a placeholder key (`@_user_1`) with the real name
 * only in `mentions`. Left in, the agent reads "@_user_1 what time is it" and
 * answers a question about a username.
 *
 * Exported because it is the one piece of this file testable without a tenant,
 * and it is the piece that decides whether the agent sees the actual question.
 */
export function feishuMessageText(
  messageType: string,
  content: string,
  mentions?: Array<{ key?: string }>,
): string {
  if (messageType !== "text") return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return "";
  }
  const text = (parsed as { text?: unknown } | null)?.text;
  if (typeof text !== "string") return "";
  let out = text;
  for (const mention of mentions ?? []) {
    if (mention.key) out = out.split(mention.key).join(" ");
  }
  return out.trim();
}

/**
 * Ask one cloud whether this app exists on it.
 *
 * Reads the envelope and never the status: both clouds answer a rejected app
 * with HTTP 200 and a non-zero `code`.
 */
export async function feishuCloudAccepts(
  host: string,
  appId: string,
  appSecret: string,
): Promise<{ ok: true } | { ok: false; why: string }> {
  let res: Response;
  try {
    res = await fetch(`${host}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, why: `could not be reached (${String(e)})` };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    return { ok: false, why: `answered HTTP ${res.status} with something that is not JSON` };
  }
  const envelope = body as { code?: number; msg?: string } | null;
  if (envelope?.code === 0) return { ok: true };
  return { ok: false, why: envelope?.msg ?? `code ${envelope?.code ?? "?"}` };
}

export class FeishuConnector implements LiveConnector {
  #ctx: ConnectorContext | null = null;
  #ws: WSClient | null = null;
  #client: Client | null = null;
  #live = false;
  #error: string | undefined;
  #allow = new Set<string>();
  #chats = new Set<string>();
  #appId = "";

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    const appId = (ctx.secrets.FEISHU_APP_ID ?? "").trim();
    const appSecret = (ctx.secrets.FEISHU_APP_SECRET ?? "").trim();
    if (!appId || !appSecret) {
      throw new Error(
        "feishu: enabled but no app credentials (expected secrets.FEISHU_APP_ID and " +
          "secrets.FEISHU_APP_SECRET — create an app at https://open.feishu.cn/app, " +
          "or https://open.larksuite.com/app outside mainland China)",
      );
    }
    this.#appId = appId;

    const cloud = await this.#pickCloud(ctx, appId, appSecret);

    this.#allow = new Set((ctx.row.allowlist ?? []).map((s) => s.trim()).filter(Boolean));
    this.#chats = new Set((ctx.row.channels ?? []).map((s) => s.trim()).filter(Boolean));

    this.#client = new Client({
      appId,
      appSecret,
      domain: cloud.domain,
      loggerLevel: LoggerLevel.error,
    });

    const dispatcher = new EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        await this.#onMessage(data);
      },
    });

    this.#ws = new WSClient({
      appId,
      appSecret,
      domain: cloud.domain,
      loggerLevel: LoggerLevel.error,
      onError: (err) => {
        this.#live = false;
        this.#error = String(err);
        ctx.log(`feishu: connection failed: ${String(err)}`);
      },
      onReconnected: () => {
        this.#live = true;
        this.#error = undefined;
      },
    });

    ctx.log(
      `feishu: connecting to ${cloud.name} as app ${appId} (${
        this.#allow.size === 0
          ? "0 allowed — NOBODY CAN REACH IT: the allowlist is empty, so every message is ignored. " +
            "Add Feishu open_id values to the allowlist to make it answer."
          : `${this.#allow.size} allowed`
      })`,
    );

    // Resolves once the first handshake succeeds, so a rejected app or a
    // blocked outbound socket fails HERE with a sentence rather than as a
    // connector that reports healthy and never receives anything.
    await this.#ws.start({ eventDispatcher: dispatcher });

    ctx.askRouter.registerSender("feishu", (sessionId, text) => this.send(sessionId, text));
    this.#live = true;
    this.#error = undefined;
  }

  /**
   * Which cloud is this app on? Ask both rather than make the person choose.
   *
   * `FEISHU_DOMAIN` in metadata skips the probe, for a private deployment or
   * for anyone who would rather pin it.
   */
  async #pickCloud(ctx: ConnectorContext, appId: string, appSecret: string): Promise<Cloud> {
    const pinned = (ctx.row.metadata?.FEISHU_DOMAIN ?? "").trim().toLowerCase();
    if (pinned) {
      const found = CLOUDS.find((c) => c.name === pinned);
      if (!found) {
        throw new Error(
          `feishu: FEISHU_DOMAIN is "${pinned}", which is not a cloud Cinderpaw knows — ` +
            `use "feishu" (mainland China) or "lark" (everywhere else), or remove it and ` +
            `Cinderpaw will work it out`,
        );
      }
      ctx.log(`feishu: using ${found.name} because FEISHU_DOMAIN pins it`);
      return found;
    }

    const why: string[] = [];
    for (const cloud of CLOUDS) {
      const answer = await feishuCloudAccepts(cloud.host, appId, appSecret);
      if (answer.ok) return cloud;
      why.push(`${cloud.name} said "${answer.why}"`);
    }
    throw new Error(
      `feishu: neither cloud accepted this app. ${why.join("; ")}. ` +
        `Check the app id and secret at https://open.feishu.cn/app (mainland China) or ` +
        `https://open.larksuite.com/app (everywhere else) — an app created on one does ` +
        `not exist on the other.`,
    );
  }

  async stop(): Promise<void> {
    this.#live = false;
    this.#ws?.close();
    this.#ws = null;
    this.#client = null;
    this.#ctx?.askRouter.unregisterSender("feishu");
  }

  health(): ConnectorHealth {
    return this.#live
      ? { live: true }
      : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseFeishuSession(sessionId);
    const client = this.#client;
    if (!target || !client) return;
    for (const part of formatForChat(text, FEISHU_MAX)) {
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: target.chatId,
          msg_type: "text",
          content: JSON.stringify({ text: part }),
        },
      });
    }
  }

  /**
   * A file into the chat behind `sessionId`.
   *
   * Feishu has two upload doors and picking the wrong one is visible to the
   * person: an image uploaded as a FILE arrives as an attachment to download,
   * and the same bytes uploaded as an IMAGE appear in the conversation. So a
   * picture goes through `im.image` and everything else through `im.file`,
   * which is also where the two different size limits come from (10 MB for
   * an image, 30 MB for a file) - checked here, because the SDK surfaces the
   * platform's refusal as a bare code.
   *
   * `file_type` is the platform's own short list; anything not on it is
   * `stream`, which is the documented catch-all and keeps the extension in
   * the file name.
   */
  async sendFile(sessionId: string, file: OutboundFile): Promise<void> {
    const target = parseFeishuSession(sessionId);
    const client = this.#client;
    if (!target || !client) throw new Error("Feishu: that conversation is not a chat I can post in.");

    const mime = mimeForName(file.name);
    const isImage = mime.startsWith("image/") && !mime.includes("svg");
    const megabytes = Math.ceil(file.data.byteLength / 1024 / 1024);
    const cap = isImage ? FEISHU_IMAGE_MAX_BYTES : FEISHU_FILE_MAX_BYTES;
    if (file.data.byteLength > cap) {
      throw new Error(
        `"${file.name}" is ${megabytes} MB and Feishu accepts at most ${cap / 1024 / 1024} MB ${isImage ? "for an image" : "for a file"}.`,
      );
    }

    const buffer = Buffer.from(file.data);
    let content: string;
    if (isImage) {
      const up = await client.im.image.create({ data: { image_type: "message", image: buffer } });
      if (!up?.image_key) throw new Error("Feishu accepted the image but returned no image key.");
      content = JSON.stringify({ image_key: up.image_key });
    } else {
      const up = await client.im.file.create({
        data: { file_type: feishuFileType(file.name), file_name: file.name, file: buffer },
      });
      if (!up?.file_key) throw new Error("Feishu accepted the file but returned no file key.");
      content = JSON.stringify({ file_key: up.file_key });
    }

    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: target.chatId, msg_type: isImage ? "image" : "file", content },
    });
    // The caption is a second message: Feishu's file message carries no text.
    if (file.caption.trim()) await this.send(sessionId, file.caption);
  }

  async #onMessage(data: {
    sender?: { sender_id?: { open_id?: string }; sender_type?: string };
    message?: {
      message_id?: string;
      chat_id?: string;
      message_type?: string;
      content?: string;
      mentions?: Array<{ key?: string }>;
    };
  }): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;

    const message = data.message;
    if (!message) return;
    const chatId = String(message.chat_id ?? "");
    const openId = String(data.sender?.sender_id?.open_id ?? "");
    const text = feishuMessageText(
      String(message.message_type ?? ""),
      String(message.content ?? ""),
      message.mentions,
    );

    if (!chatId || !openId || !text) {
      // Not silent: the event shape is the part nobody could verify without a
      // Feishu tenant, so a message we cannot read has to leave a trace. A
      // non-text message (an image, a file) is a normal thing to skip, and it
      // is logged with its type so the reason is legible.
      if (chatId || openId) {
        ctx.log(
          `feishu: dropped a ${message.message_type ?? "(no type)"} message — ` +
            `nothing readable in it`,
        );
      }
      return;
    }

    // The app's own messages come back on the same socket.
    if (data.sender?.sender_type && data.sender.sender_type !== "user") return;
    if (openId === this.#appId) return;
    if (this.#chats.size > 0 && !this.#chats.has(chatId)) return;

    if (!this.#allow.has(openId)) {
      ctx.log(`feishu: ignored message from non-allowlisted ${openId}`);
      return;
    }

    const sessionId = feishuSessionId(chatId, openId);

    const command = await runChatCommand(ctx.agent, sessionId, text);
    if (command) {
      await this.send(sessionId, command);
      return;
    }
    if (ctx.askRouter.handleInbound(sessionId, text)) return;

    if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
    ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("Feishu"));

    try {
      const { reply } = await runAgent(
        ctx.agent,
        sessionId,
        `[user:${openId}] ${text}`,
        `feishu-${message.message_id ?? Date.now()}`,
      );
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`feishu: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e));
    }
  }
}

registerTransport("feishu", () => new FeishuConnector());
