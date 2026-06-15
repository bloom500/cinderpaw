/**
 * Connector Surface (inbound) — talk to the LOCAL agent from messaging apps.
 *
 * A connector is NOT a second agent: it shares the one `AgentLoop` running in
 * this sidecar, so a Discord message is answered by the same local model and
 * the same tools as the desktop app. The host (Rust) owns configuration
 * (`~/.feral/connectors.json`: enabled, bot token, allowlist) and pokes us with
 * a `connectors_reload` stdin message whenever it changes; `ConnectorManager`
 * reconciles the live connections.
 *
 * Security: only senders whose exact Discord user ID is on the allowlist are
 * answered. Everyone else is ignored silently. The allowlist is the gate that
 * exposes this machine's agent (and its full tools) — empty = nobody.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  type Message,
} from "discord.js";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import type { OutboundEvent } from "../types.ts";

/** The slice of `AgentLoop` a connector needs. */
export interface AgentLike {
  handle(
    sessionId: string,
    userText: string,
    messageId: string,
    emit: (event: OutboundEvent) => void,
  ): Promise<string>;
}

type Log = (message: string) => void;

const DISCORD_MAX = 2000;

/** Split a reply into Discord-sized chunks without cutting mid-line when avoidable. */
function chunk(text: string): string[] {
  const trimmed = text.trim() || "(no response)";
  if (trimmed.length <= DISCORD_MAX) return [trimmed];
  const out: string[] = [];
  let rest = trimmed;
  while (rest.length > DISCORD_MAX) {
    let cut = rest.lastIndexOf("\n", DISCORD_MAX);
    if (cut < DISCORD_MAX * 0.5) cut = DISCORD_MAX; // no good break — hard split
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

/** Strip MCP prefixes / separators so a tool id reads like a phrase. */
function prettyTool(tool: string): string {
  return tool.replace(/^mcp__/, "").replace(/__/g, " · ").replace(/[_-]+/g, " ").trim();
}

/**
 * Map an agent tool to a human "what am I doing right now" status with an
 * emoji, shown live in Discord while the agent works. Pattern-matched so new
 * builtin or MCP tools degrade to a sensible generic label.
 */
function activityFor(tool: string): { emoji: string; label: string } {
  const t = tool.toLowerCase();
  const has = (...xs: string[]) => xs.some((x) => t.includes(x));
  if (has("deep_research")) return { emoji: "🔬", label: "Researching in depth…" };
  if (has("web_search")) return { emoji: "🔍", label: "Searching the web…" };
  if (has("fetch_url", "read_webpage", "http_request", "browse")) return { emoji: "🌐", label: "Browsing the web…" };
  if (has("write_file", "edit_file")) return { emoji: "✍️", label: "Writing files…" };
  if (has("read_file", "list_directory", "file_search", "grep", "scan_workspace", "read_skill")) return { emoji: "📂", label: "Reading files…" };
  if (has("shell", "exec", "command")) return { emoji: "🖥️", label: "Running a command…" };
  if (has("git")) return { emoji: "🔧", label: "Working with Git…" };
  if (has("memory")) return { emoji: "🧠", label: "Checking memory…" };
  if (has("discord")) return { emoji: "💬", label: "Working with Discord…" };
  if (has("slack")) return { emoji: "💬", label: "Working with Slack…" };
  if (has("desktop", "control", "click", "type_into", "window", "element", "launch_app", "send_keys")) return { emoji: "🖱️", label: "Controlling the desktop…" };
  if (has("delegate", "subagent")) return { emoji: "🤝", label: "Delegating a subtask…" };
  if (has("calculator", "calc")) return { emoji: "🔢", label: "Calculating…" };
  if (has("time", "date")) return { emoji: "🕐", label: "Checking the time…" };
  if (has("code_quality")) return { emoji: "🧪", label: "Checking code quality…" };
  if (has("mcp__")) return { emoji: "🔌", label: `Using ${prettyTool(tool)}…` };
  return { emoji: "🔧", label: `Working — ${prettyTool(tool)}…` };
}

/** Run one agent turn, mapping its tool events to a friendly status string. */
async function runAgent(
  agent: AgentLike,
  sessionId: string,
  text: string,
  messageId: string,
  onActivity?: (status: string) => void,
): Promise<string> {
  return agent.handle(sessionId, text, messageId, (event) => {
    if (!onActivity) return;
    if (event.type === "tool_start") {
      const a = activityFor(event.tool);
      onActivity(`${a.emoji} ${a.label}`);
    } else if (event.type === "tool_progress" && event.message) {
      const a = activityFor(event.tool);
      onActivity(`${a.emoji} ${event.message}`);
    }
  });
}

/** Digits only — used to compare phone numbers across formats. */
function digits(s: string): string {
  return s.replace(/\D/g, "");
}

/** A live Discord gateway connection that drives the shared agent. */
export class DiscordConnector {
  readonly #token: string;
  readonly #allow: Set<string>;
  /** Channels where any allowlisted message is answered without an @mention. */
  readonly #channels: Set<string>;
  readonly #agent: AgentLike;
  readonly #log: Log;
  #client: Client | null = null;

  constructor(opts: { token: string; allowlist: string[]; channels: string[]; agent: AgentLike; log: Log }) {
    this.#token = opts.token;
    this.#allow = new Set(opts.allowlist.map((s) => s.trim()).filter(Boolean));
    this.#channels = new Set(opts.channels.map((s) => s.trim()).filter(Boolean));
    this.#agent = opts.agent;
    this.#log = opts.log;
  }

  async start(): Promise<void> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
    this.#client = client;

    client.once(Events.ClientReady, (c) =>
      this.#log(`discord connector online as ${c.user.tag} (${this.#allow.size} allowed)`),
    );
    client.on(Events.MessageCreate, (msg) => {
      void this.#onMessage(msg).catch((e) => this.#log(`discord message error: ${String(e)}`));
    });
    client.on(Events.Error, (e) => this.#log(`discord client error: ${String(e)}`));

    await client.login(this.#token);
  }

  async stop(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    if (client) {
      try {
        await client.destroy();
      } catch {
        // already closed
      }
    }
  }

  async #onMessage(message: Message): Promise<void> {
    const me = this.#client?.user;
    if (!me || message.author.bot) return;

    const isDM = message.channel.type === ChannelType.DM;
    const mentioned = message.mentions.users.has(me.id);
    const dedicated = this.#channels.has(message.channelId);

    // Reply-to-continue: once a thread is going, replying to one of the bot's
    // own messages keeps the conversation alive without re-@mentioning it.
    let replyToBot = false;
    if (!isDM && !mentioned && !dedicated && message.reference?.messageId && "messages" in message.channel) {
      const ref = await message.channel.messages
        .fetch(message.reference.messageId)
        .catch(() => null);
      replyToBot = ref?.author.id === me.id;
    }

    // When to answer: always in DMs; in a dedicated channel; on @mention; or
    // when continuing a reply thread with the bot. Otherwise stay quiet so the
    // bot never barges into conversations between other people.
    if (!isDM && !mentioned && !dedicated && !replyToBot) return;

    // Allowlist gate — exact user ID. Unlisted senders get no reply at all.
    if (!this.#allow.has(message.author.id)) {
      this.#log(`discord: ignored message from non-allowlisted ${message.author.id}`);
      return;
    }

    const text = message.content.replace(new RegExp(`<@!?${me.id}>`, "g"), "").trim();
    if (!text) return;

    const sessionId = `discord:${message.channelId}`;
    const channel = message.channel;

    // Discord's typing indicator self-expires after ~10s. Agent turns that use
    // tools routinely run much longer, so the indicator vanishes and the user
    // thinks the bot died. Re-poke it every 8s for the whole turn so "… is
    // typing" stays visible continuously until the reply lands.
    const pokeTyping = () => {
      if ("sendTyping" in channel) void channel.sendTyping().catch(() => {});
    };
    pokeTyping();
    const keepTyping = setInterval(pokeTyping, 8000);
    // Instant acknowledgement: the Feral paw lands on the message the moment we
    // pick it up, so the user knows it was heard even before "typing" shows.
    const react = (emoji: string) => void message.react(emoji).catch(() => {});
    react("🐾");

    // Live status: one message we edit as the agent works, so the user sees
    // exactly what it's doing right now (searching, reading, running a
    // command…). The same message morphs into the final answer at the end, so
    // there's no extra message spam. Edits are throttled to stay clear of
    // Discord's ~5-edits/5s rate limit.
    const statusMsg = await message.reply("🐾 On it…").catch(() => null);
    let lastEdit = 0;
    let pendingStatus: string | null = null;
    let editTimer: ReturnType<typeof setTimeout> | null = null;
    const flushStatus = () => {
      editTimer = null;
      if (pendingStatus == null || !statusMsg) return;
      const next = pendingStatus;
      pendingStatus = null;
      lastEdit = Date.now();
      void statusMsg.edit(next).catch(() => {});
    };
    const setStatus = (s: string) => {
      if (!statusMsg) return;
      pendingStatus = s;
      const since = Date.now() - lastEdit;
      if (since >= 1100) {
        if (editTimer) clearTimeout(editTimer);
        flushStatus();
      } else if (!editTimer) {
        editTimer = setTimeout(flushStatus, 1100 - since);
      }
    };

    try {
      // The shared agent answers with the same model + tools as the app. We
      // watch its tool events to drive the live status message.
      const reply = await this.#agent.handle(sessionId, text, `discord-${message.id}`, (event) => {
        if (event.type === "tool_start") {
          const a = activityFor(event.tool);
          setStatus(`${a.emoji} ${a.label}`);
        } else if (event.type === "tool_progress" && event.message) {
          const a = activityFor(event.tool);
          setStatus(`${a.emoji} ${event.message}`);
        }
      });

      // Done working: stop status churn and turn the status message into the
      // answer (or post a fresh reply if the status message never landed).
      if (editTimer) clearTimeout(editTimer);
      pendingStatus = null;
      const parts = chunk(reply);
      if (statusMsg) {
        await statusMsg.edit(parts[0] ?? "(no response)");
      } else {
        await message.reply(parts[0] ?? "(no response)");
      }
      if ("send" in channel) {
        for (const part of parts.slice(1)) {
          await channel.send(part);
        }
      }
      react("✅");
    } catch (e) {
      this.#log(`discord: agent error: ${String(e)}`);
      react("⚠️");
      if (editTimer) clearTimeout(editTimer);
      try {
        if (statusMsg) await statusMsg.edit("Sorry — something went wrong handling that.");
        else await message.reply("Sorry — something went wrong handling that.");
      } catch {
        // channel may be gone
      }
    } finally {
      clearInterval(keepTyping);
    }
  }
}

// ---------------------------------------------------------------------------
// Slack connector (Socket Mode — outbound websocket, no public URL)
// ---------------------------------------------------------------------------

export class SlackConnector {
  readonly #appToken: string;
  readonly #botToken: string;
  readonly #allow: Set<string>;
  readonly #channels: Set<string>;
  readonly #agent: AgentLike;
  readonly #log: Log;
  #socket: SocketModeClient | null = null;
  #web: WebClient | null = null;
  #botUserId = "";

  constructor(opts: { appToken: string; botToken: string; allowlist: string[]; channels: string[]; agent: AgentLike; log: Log }) {
    this.#appToken = opts.appToken;
    this.#botToken = opts.botToken;
    this.#allow = new Set(opts.allowlist.map((s) => s.trim()).filter(Boolean));
    this.#channels = new Set(opts.channels.map((s) => s.trim()).filter(Boolean));
    this.#agent = opts.agent;
    this.#log = opts.log;
  }

  async start(): Promise<void> {
    this.#web = new WebClient(this.#botToken);
    const auth = await this.#web.auth.test();
    this.#botUserId = (auth.user_id as string) ?? "";
    this.#socket = new SocketModeClient({ appToken: this.#appToken });
    // socket-mode emits one event per Slack event type; we only want messages.
    this.#socket.on("message", async (args: { ack?: () => Promise<void>; event?: Record<string, unknown> }) => {
      await args.ack?.();
      await this.#onMessage(args.event ?? {}).catch((e) => this.#log(`slack message error: ${String(e)}`));
    });
    await this.#socket.start();
    this.#log(`slack connector online as ${this.#botUserId} (${this.#allow.size} allowed)`);
  }

  async stop(): Promise<void> {
    const s = this.#socket;
    this.#socket = null;
    try {
      await s?.disconnect();
    } catch {
      // already gone
    }
  }

  async #onMessage(event: Record<string, unknown>): Promise<void> {
    // Ignore bot messages, edits, joins and other subtypes.
    if (event.bot_id || event.subtype) return;
    const user = event.user as string | undefined;
    const channel = event.channel as string | undefined;
    const raw = (event.text as string | undefined) ?? "";
    if (!user || !channel) return;

    const isIM = event.channel_type === "im";
    const mentioned = !!this.#botUserId && raw.includes(`<@${this.#botUserId}>`);
    const dedicated = this.#channels.has(channel);
    if (!isIM && !mentioned && !dedicated) return;

    if (!this.#allow.has(user)) {
      this.#log(`slack: ignored message from non-allowlisted ${user}`);
      return;
    }
    const text = raw.replace(new RegExp(`<@${this.#botUserId}>`, "g"), "").trim();
    if (!text) return;

    const web = this.#web!;
    const threadTs = (event.thread_ts as string | undefined) ?? (event.ts as string | undefined);
    const sessionId = `slack:${channel}`;
    void web.reactions.add({ channel, timestamp: event.ts as string, name: "paw_prints" }).catch(() => {});

    const status = await web.chat
      .postMessage({ channel, text: "🐾 On it…", thread_ts: threadTs })
      .catch(() => null);
    const ts = status?.ts as string | undefined;

    let lastEdit = 0;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (pending == null || !ts) return;
      const next = pending;
      pending = null;
      lastEdit = Date.now();
      void web.chat.update({ channel, ts, text: next }).catch(() => {});
    };
    const setStatus = (s: string) => {
      if (!ts) return;
      pending = s;
      const since = Date.now() - lastEdit;
      if (since >= 1200) {
        if (timer) clearTimeout(timer);
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, 1200 - since);
      }
    };

    try {
      const reply = await runAgent(this.#agent, sessionId, text, `slack-${event.ts}`, setStatus);
      if (timer) clearTimeout(timer);
      pending = null;
      const parts = chunk(reply);
      if (ts) await web.chat.update({ channel, ts, text: parts[0] ?? "(no response)" });
      else await web.chat.postMessage({ channel, text: parts[0] ?? "(no response)", thread_ts: threadTs });
      for (const part of parts.slice(1)) {
        await web.chat.postMessage({ channel, text: part, thread_ts: threadTs });
      }
      void web.reactions.add({ channel, timestamp: event.ts as string, name: "white_check_mark" }).catch(() => {});
    } catch (e) {
      this.#log(`slack: agent error: ${String(e)}`);
      if (timer) clearTimeout(timer);
      void web.reactions.add({ channel, timestamp: event.ts as string, name: "warning" }).catch(() => {});
      try {
        if (ts) await web.chat.update({ channel, ts, text: "Sorry — something went wrong handling that." });
        else await web.chat.postMessage({ channel, text: "Sorry — something went wrong handling that.", thread_ts: threadTs });
      } catch {
        // channel may be gone
      }
    }
  }
}

// ---------------------------------------------------------------------------
// WhatsApp connector (Baileys — direct WebSocket, no browser, QR linked)
// ---------------------------------------------------------------------------

export class WhatsAppConnector {
  readonly #allow: Set<string>;
  readonly #channels: Set<string>;
  readonly #agent: AgentLike;
  readonly #log: Log;
  #sock: WASocket | null = null;
  #stopped = false;

  constructor(opts: { allowlist: string[]; channels: string[]; agent: AgentLike; log: Log }) {
    this.#allow = new Set(opts.allowlist.map(digits).filter(Boolean));
    this.#channels = new Set(opts.channels.map((s) => s.trim()).filter(Boolean));
    this.#agent = opts.agent;
    this.#log = opts.log;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    await this.#connect();
  }

  async #connect(): Promise<void> {
    const authDir = join(homedir(), ".feral", "whatsapp-auth");
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const sock = makeWASocket({ auth: state });
    this.#sock = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        this.#log("whatsapp: scan this QR with WhatsApp → Settings → Linked devices:");
        qrcode.generate(qr, { small: true }, (ascii) => process.stderr.write("\n" + ascii + "\n"));
      }
      if (connection === "open") this.#log("whatsapp connector online (linked)");
      if (connection === "close") {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (this.#stopped) return;
        if (loggedOut) {
          this.#log("whatsapp: logged out — toggle the connector off and on to re-link.");
        } else {
          this.#log("whatsapp: connection closed, reconnecting…");
          void this.#connect().catch((e) => this.#log(`whatsapp reconnect failed: ${String(e)}`));
        }
      }
    });

    sock.ev.on("messages.upsert", (up) => {
      if (up.type !== "notify") return;
      for (const msg of up.messages) {
        void this.#onMessage(msg).catch((e) => this.#log(`whatsapp message error: ${String(e)}`));
      }
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    try {
      this.#sock?.end(undefined);
    } catch {
      // already closed
    }
    this.#sock = null;
  }

  async #onMessage(msg: WAMessage): Promise<void> {
    if (!msg.message || msg.key.fromMe) return;
    const jid = msg.key.remoteJid ?? "";
    const isGroup = jid.endsWith("@g.us");
    const isPrivate = jid.endsWith("@s.whatsapp.net");
    if (!isPrivate && !isGroup) return; // skip status/broadcast

    const sender = isGroup ? (msg.key.participant ?? "") : jid;
    const senderNum = digits(sender);
    const text = (msg.message.conversation ?? msg.message.extendedTextMessage?.text ?? "").trim();
    if (!text) return;

    // Private chats answer like DMs; groups only when listed as a dedicated chat.
    const dedicated = this.#channels.has(jid) || this.#channels.has(senderNum);
    if (isGroup && !dedicated) return;
    if (!this.#allow.has(senderNum)) {
      this.#log(`whatsapp: ignored message from non-allowlisted ${senderNum}`);
      return;
    }

    const sock = this.#sock!;
    const sessionId = `whatsapp:${jid}`;
    void sock.sendMessage(jid, { react: { text: "🐾", key: msg.key } }).catch(() => {});
    void sock.sendPresenceUpdate("composing", jid).catch(() => {});
    const keepTyping = setInterval(() => {
      void sock.sendPresenceUpdate("composing", jid).catch(() => {});
    }, 8000);

    try {
      const reply = await runAgent(this.#agent, sessionId, text, `wa-${msg.key.id}`);
      const parts = chunk(reply);
      for (const part of parts) {
        await sock.sendMessage(jid, { text: part });
      }
      void sock.sendMessage(jid, { react: { text: "✅", key: msg.key } }).catch(() => {});
    } catch (e) {
      this.#log(`whatsapp: agent error: ${String(e)}`);
      void sock.sendMessage(jid, { react: { text: "⚠️", key: msg.key } }).catch(() => {});
      try {
        await sock.sendMessage(jid, { text: "Sorry — something went wrong handling that." });
      } catch {
        // chat may be gone
      }
    } finally {
      clearInterval(keepTyping);
      void sock.sendPresenceUpdate("paused", jid).catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Manager — reconciles live connectors against ~/.feral/connectors.json
// ---------------------------------------------------------------------------

interface ConnectorRow {
  id: string;
  enabled?: boolean;
  secrets?: Record<string, string>;
  allowlist?: string[];
  channels?: string[];
  /** Legacy single-token field (pre-multi-secret configs); Discord fallback. */
  token?: string;
}

function configPath(): string {
  return join(homedir(), ".feral", "connectors.json");
}

const sig = (...parts: (string[] | string | undefined)[]): string =>
  parts.map((p) => (Array.isArray(p) ? [...p].sort().join(",") : p ?? "")).join("|");

export class ConnectorManager {
  readonly #agent: AgentLike;
  readonly #log: Log;
  #discord: DiscordConnector | null = null;
  #discordKey = "";
  #slack: SlackConnector | null = null;
  #slackKey = "";
  #whatsapp: WhatsAppConnector | null = null;
  #whatsappKey = "";
  /** Serialize reloads so overlapping pokes can't double-start a connection. */
  #reloading: Promise<void> = Promise.resolve();

  constructor(agent: AgentLike, log: Log) {
    this.#agent = agent;
    this.#log = log;
  }

  /** Re-read config and start/stop/restart connectors to match it. */
  reload(): Promise<void> {
    this.#reloading = this.#reloading.then(() => this.#reload()).catch((e) => {
      this.#log(`connectors reload error: ${String(e)}`);
    });
    return this.#reloading;
  }

  async #reload(): Promise<void> {
    let rows: ConnectorRow[] = [];
    try {
      const raw = await readFile(configPath(), "utf8");
      const parsed = JSON.parse(raw) as { connectors?: ConnectorRow[] };
      rows = Array.isArray(parsed.connectors) ? parsed.connectors : [];
    } catch {
      rows = []; // no file yet → everything off
    }
    await this.#reconcileDiscord(rows.find((r) => r.id === "discord"));
    await this.#reconcileSlack(rows.find((r) => r.id === "slack"));
    await this.#reconcileWhatsApp(rows.find((r) => r.id === "whatsapp"));
  }

  async #reconcileDiscord(row?: ConnectorRow): Promise<void> {
    // Fall back to the legacy single `token` field for configs written before
    // the multi-secret migration (until the next save rewrites the file).
    const token = row?.secrets?.DISCORD_TOKEN?.trim() || row?.token?.trim();
    if (!row?.enabled || !token) {
      if (this.#discord) {
        await this.#discord.stop();
        this.#discord = null;
        this.#discordKey = "";
        this.#log("discord connector stopped");
      }
      return;
    }
    const key = sig(token, row.allowlist, row.channels);
    if (this.#discord && key === this.#discordKey) return;
    if (this.#discord) await this.#discord.stop();
    this.#discord = null;
    const conn = new DiscordConnector({ token, allowlist: row.allowlist ?? [], channels: row.channels ?? [], agent: this.#agent, log: this.#log });
    try {
      await conn.start();
      this.#discord = conn;
      this.#discordKey = key;
    } catch (e) {
      this.#log(`discord connector failed to start: ${String(e)}`);
      await conn.stop();
    }
  }

  async #reconcileSlack(row?: ConnectorRow): Promise<void> {
    const appToken = row?.secrets?.SLACK_APP_TOKEN?.trim();
    const botToken = row?.secrets?.SLACK_BOT_TOKEN?.trim();
    if (!row?.enabled || !appToken || !botToken) {
      if (this.#slack) {
        await this.#slack.stop();
        this.#slack = null;
        this.#slackKey = "";
        this.#log("slack connector stopped");
      }
      return;
    }
    const key = sig(appToken, botToken, row.allowlist, row.channels);
    if (this.#slack && key === this.#slackKey) return;
    if (this.#slack) await this.#slack.stop();
    this.#slack = null;
    const conn = new SlackConnector({ appToken, botToken, allowlist: row.allowlist ?? [], channels: row.channels ?? [], agent: this.#agent, log: this.#log });
    try {
      await conn.start();
      this.#slack = conn;
      this.#slackKey = key;
    } catch (e) {
      this.#log(`slack connector failed to start: ${String(e)}`);
      await conn.stop();
    }
  }

  async #reconcileWhatsApp(row?: ConnectorRow): Promise<void> {
    if (!row?.enabled) {
      if (this.#whatsapp) {
        await this.#whatsapp.stop();
        this.#whatsapp = null;
        this.#whatsappKey = "";
        this.#log("whatsapp connector stopped");
      }
      return;
    }
    const key = sig(row.allowlist, row.channels);
    if (this.#whatsapp && key === this.#whatsappKey) return;
    if (this.#whatsapp) await this.#whatsapp.stop();
    this.#whatsapp = null;
    const conn = new WhatsAppConnector({ allowlist: row.allowlist ?? [], channels: row.channels ?? [], agent: this.#agent, log: this.#log });
    try {
      await conn.start();
      this.#whatsapp = conn;
      this.#whatsappKey = key;
    } catch (e) {
      this.#log(`whatsapp connector failed to start: ${String(e)}`);
      await conn.stop();
    }
  }

  async stopAll(): Promise<void> {
    await this.#discord?.stop();
    await this.#slack?.stop();
    await this.#whatsapp?.stop();
    this.#discord = null;
    this.#slack = null;
    this.#whatsapp = null;
  }
}
