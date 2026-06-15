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

/** A live Discord gateway connection that drives the shared agent. */
export class DiscordConnector {
  readonly #token: string;
  readonly #allow: Set<string>;
  readonly #agent: AgentLike;
  readonly #log: Log;
  #client: Client | null = null;

  constructor(opts: { token: string; allowlist: string[]; agent: AgentLike; log: Log }) {
    this.#token = opts.token;
    this.#allow = new Set(opts.allowlist.map((s) => s.trim()).filter(Boolean));
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
    if (!isDM && !mentioned) return; // v1 scope: DMs and @mentions only

    // Allowlist gate — exact user ID. Unlisted senders get no reply at all.
    if (!this.#allow.has(message.author.id)) {
      this.#log(`discord: ignored message from non-allowlisted ${message.author.id}`);
      return;
    }

    const text = message.content.replace(new RegExp(`<@!?${me.id}>`, "g"), "").trim();
    if (!text) return;

    const sessionId = `discord:${message.channelId}`;
    try {
      if ("sendTyping" in message.channel) {
        await message.channel.sendTyping().catch(() => {});
      }
      // The shared agent answers with the same model + tools as the app.
      // emit is a no-op here: we post the final returned text (v1 = buffered;
      // token streaming/edited replies are a v2 refinement).
      const reply = await this.#agent.handle(sessionId, text, `discord-${message.id}`, () => {});
      const parts = chunk(reply);
      await message.reply(parts[0] ?? "(no response)");
      if ("send" in message.channel) {
        for (const part of parts.slice(1)) {
          await message.channel.send(part);
        }
      }
    } catch (e) {
      this.#log(`discord: agent error: ${String(e)}`);
      try {
        await message.reply("Sorry — something went wrong handling that.");
      } catch {
        // channel may be gone
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Manager — reconciles live connectors against ~/.feral/connectors.json
// ---------------------------------------------------------------------------

interface ConnectorRow {
  id: string;
  enabled?: boolean;
  token?: string;
  allowlist?: string[];
}

function configPath(): string {
  return join(homedir(), ".feral", "connectors.json");
}

export class ConnectorManager {
  readonly #agent: AgentLike;
  readonly #log: Log;
  #discord: DiscordConnector | null = null;
  /** token + allowlist signature, to skip restarts when nothing changed. */
  #discordKey = "";
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

    const discord = rows.find((r) => r.id === "discord");
    const wantDiscord = !!discord?.enabled && !!discord.token?.trim();

    if (!wantDiscord) {
      if (this.#discord) {
        await this.#discord.stop();
        this.#discord = null;
        this.#discordKey = "";
        this.#log("discord connector stopped");
      }
      return;
    }

    const allowlist = discord!.allowlist ?? [];
    const key = `${discord!.token}|${[...allowlist].sort().join(",")}`;
    if (this.#discord && key === this.#discordKey) return; // unchanged

    if (this.#discord) {
      await this.#discord.stop();
      this.#discord = null;
    }
    const conn = new DiscordConnector({
      token: discord!.token!.trim(),
      allowlist,
      agent: this.#agent,
      log: this.#log,
    });
    try {
      await conn.start();
      this.#discord = conn;
      this.#discordKey = key;
    } catch (e) {
      this.#log(`discord connector failed to start: ${String(e)}`);
      await conn.stop();
    }
  }

  async stopAll(): Promise<void> {
    if (this.#discord) {
      await this.#discord.stop();
      this.#discord = null;
    }
  }
}
