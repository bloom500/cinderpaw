/**
 * IRC — the oldest protocol here, and the one with the sharpest edge.
 *
 * Second of the OpenClaw 21 for the same reason as Telegram: it dials out
 * over a plain socket, so it needs no public address and nothing installed.
 *
 * Two details taken from their implementation because both are easy to get
 * wrong and expensive to find out about later:
 *
 *  1. The 512 limit is BYTES PER LINE, and the line includes
 *     `PRIVMSG <target> :` and the trailing CRLF. So the text budget depends
 *     on how long the channel name is, and it is measured in UTF-8 bytes, not
 *     characters — one emoji is four of them. A reply that overruns is not
 *     wrapped by the server, it is truncated or the connection is dropped.
 *
 *  2. Control characters must be stripped from anything we send. This is not
 *     cosmetic. A `\r\n` inside an agent's reply ends the PRIVMSG line and
 *     the rest is read by the server as a NEW COMMAND — the agent could be
 *     talked into making itself JOIN, KICK or QUIT by a stranger who gets it
 *     to repeat a crafted string. It is command injection with a newline.
 *
 * ponytail: no SASL, no CTCP, no DCC, no channel modes. Connect, join, read,
 * reply. See the allowlist note in `#onPrivmsg` for what that costs.
 */

import {
  connectorErrorMessage,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief } from "./chat-format.ts";
import { registerTransport, type ConnectorContext, type LiveConnector } from "./registry.ts";

/** The RFC line limit, CRLF included. Everything else is measured against it. */
const IRC_MAX_LINE_BYTES = 512;

/**
 * Remove every C0 control character and DEL.
 *
 * Exported and tested on its own because it is the security boundary of this
 * file: CR and LF end an IRC line, so anything reaching `#raw` unstripped can
 * append commands of its own.
 */
export function stripIrcControlChars(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code > 0x1f && code !== 0x7f) out += ch;
  }
  return out;
}

/**
 * Split `text` into pieces that each fit one PRIVMSG to `target`.
 *
 * Byte-aware, and it prefers to break at a space so words survive. A single
 * unbreakable run longer than the budget is cut mid-word rather than dropped:
 * a truncated sentence is recoverable, a missing one is not.
 */
export function ircMessageChunks(target: string, text: string): string[] {
  // `PRIVMSG ` + target + ` :` + CRLF, plus room for the server prefixing our
  // own hostmask on echo. 100 bytes of headroom is the usual safe allowance.
  const budget = IRC_MAX_LINE_BYTES - Buffer.byteLength(`PRIVMSG ${target} :\r\n`, "utf8") - 100;
  const clean = stripIrcControlChars(text);
  const out: string[] = [];
  let rest = clean;
  while (rest.length > 0 && budget > 0) {
    let end = 0;
    let bytes = 0;
    for (const ch of rest) {
      const size = Buffer.byteLength(ch, "utf8");
      if (bytes + size > budget) break;
      end += ch.length;
      bytes += size;
    }
    if (end === 0) break; // budget smaller than one character: give up cleanly
    let piece = rest.slice(0, end);
    if (end < rest.length && rest[end] !== " ") {
      const space = piece.lastIndexOf(" ");
      if (space >= Math.floor(piece.length / 2)) piece = piece.slice(0, space);
    }
    out.push(piece.trim());
    rest = rest.slice(piece.length).trimStart();
  }
  return out.filter((p) => p.length > 0);
}

export function ircSessionId(target: string, nick: string): string {
  return `irc:${target}:${nick}`;
}

export function parseIrcSession(sessionId: string): { target: string; nick: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 3 || parts[0] !== "irc") return null;
  return { target: parts[1]!, nick: parts[2]! };
}

/** One parsed IRC line. `prefix` is the sender, absent on server messages. */
interface IrcLine {
  prefix?: string;
  command: string;
  params: string[];
}

export function parseIrcLine(raw: string): IrcLine | null {
  let rest = raw.trim();
  if (!rest) return null;
  let prefix: string | undefined;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    if (sp < 0) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  // The trailing parameter starts at " :" and is the only one that may
  // contain spaces. Everything before it is split on whitespace.
  const trailingAt = rest.indexOf(" :");
  let trailing: string | undefined;
  if (trailingAt >= 0) {
    trailing = rest.slice(trailingAt + 2);
    rest = rest.slice(0, trailingAt);
  }
  const parts = rest.split(/ +/).filter(Boolean);
  const command = parts.shift();
  if (!command) return null;
  if (trailing !== undefined) parts.push(trailing);
  return { ...(prefix ? { prefix } : {}), command: command.toUpperCase(), params: parts };
}

/** The nick out of a `nick!user@host` prefix. */
function nickOf(prefix: string | undefined): string {
  if (!prefix) return "";
  const bang = prefix.indexOf("!");
  return bang > 0 ? prefix.slice(0, bang) : prefix;
}

export class IrcConnector implements LiveConnector {
  #ctx: ConnectorContext | null = null;
  #socket: { write(data: string): void; end(): void } | null = null;
  #running = false;
  #live = false;
  #error: string | undefined;
  #nick = "";
  #allow = new Set<string>();
  #channels: string[] = [];
  #buffer = "";
  #seq = 1;

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    const host = (ctx.row.metadata?.IRC_HOST ?? ctx.secrets.IRC_HOST ?? "").trim();
    const nick = (ctx.row.metadata?.IRC_NICK ?? ctx.secrets.IRC_NICK ?? "").trim();
    if (!host) {
      throw new Error(
        "irc: no server — Cinderpaw cannot tell which IRC network to join (expected IRC_HOST, e.g. irc.libera.chat)",
      );
    }
    if (!nick) {
      throw new Error("irc: no nickname (expected IRC_NICK — the name the bot answers to)");
    }
    this.#nick = nick;
    this.#allow = new Set(
      (ctx.row.allowlist ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean),
    );
    this.#channels = (ctx.row.channels ?? []).map((s) => s.trim()).filter(Boolean);

    ctx.log(
      `irc: connecting to ${host} as ${nick} (${
        this.#allow.size === 0
          ? "0 allowed — NOBODY CAN REACH IT: the allowlist is empty, so every message is ignored. " +
            "Add nicknames to the allowlist to make it answer."
          : `${this.#allow.size} allowed`
      })`,
    );

    ctx.askRouter.registerSender("irc", (sessionId, text) => this.send(sessionId, text));
    this.#running = true;
    await this.#connect(host, ctx);
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("irc");
    try {
      this.#raw("QUIT :bye");
      this.#socket?.end();
    } catch {
      // already gone
    }
    this.#socket = null;
  }

  health(): ConnectorHealth {
    return this.#live
      ? { live: true }
      : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseIrcSession(sessionId);
    if (!target) return;
    // A channel session answers the channel; a DM session answers the person.
    const dest = target.target.startsWith("#") ? target.target : target.nick;
    for (const chunk of ircMessageChunks(dest, text)) {
      this.#raw(`PRIVMSG ${dest} :${chunk}`);
    }
  }

  #raw(line: string): void {
    // Stripped here as well as in the chunker: this is the only door to the
    // socket, so the guarantee belongs at the door rather than at each caller.
    this.#socket?.write(`${stripIrcControlChars(line)}\r\n`);
  }

  async #connect(host: string, ctx: ConnectorContext): Promise<void> {
    const port = Number(ctx.row.metadata?.IRC_PORT ?? 6697);
    // TLS by default, and off only if the config says so in as many words.
    // A default of plaintext would put the server password on the wire in
    // clear on a network the user did not choose.
    const tls = String(ctx.row.metadata?.IRC_TLS ?? "true") !== "false";
    const password = (ctx.secrets.IRC_PASSWORD ?? "").trim();

    const socket = await Bun.connect({
      hostname: host,
      port,
      ...(tls ? { tls: true } : {}),
      socket: {
        data: (_s, data: Uint8Array) => this.#onData(Buffer.from(data).toString("utf8")),
        open: () => {
          this.#live = true;
          this.#error = undefined;
          if (password) this.#raw(`PASS ${password}`);
          this.#raw(`NICK ${this.#nick}`);
          this.#raw(`USER ${this.#nick} 0 * :Cinderpaw`);
        },
        close: () => {
          if (!this.#running) return;
          this.#live = false;
          this.#error = "the connection to the IRC server dropped";
          setTimeout(() => void this.#connect(host, ctx).catch(() => {}), 5000);
        },
        error: (_s, e: Error) => {
          this.#live = false;
          this.#error = String(e);
        },
      },
    });
    this.#socket = socket as unknown as { write(d: string): void; end(): void };
  }

  /** TCP gives us bytes, not lines. Hold the tail until its CRLF arrives. */
  #onData(chunk: string): void {
    this.#buffer += chunk;
    const lines = this.#buffer.split(/\r?\n/);
    this.#buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = parseIrcLine(raw);
      if (line) void this.#onLine(line);
    }
  }

  async #onLine(line: IrcLine): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    switch (line.command) {
      case "PING":
        // Miss these and the server hangs up on you within minutes.
        this.#raw(`PONG :${line.params[line.params.length - 1] ?? ""}`);
        return;
      case "001":
        // Registered. Only now is joining allowed.
        this.#live = true;
        for (const channel of this.#channels) this.#raw(`JOIN ${channel}`);
        ctx.log(`irc: registered as ${this.#nick}, joined ${this.#channels.length} channel(s)`);
        return;
      case "433":
      case "436":
        // Nick taken. Retrying the same nick forever is how a bot spins; say
        // it once and stay down so the user can pick another.
        this.#error = `the nickname "${this.#nick}" is already in use on this network — choose another in the connector settings`;
        ctx.log(`irc: ${this.#error}`);
        this.#running = false;
        this.#socket?.end();
        return;
      case "464":
        this.#error = "the server rejected the password";
        ctx.log(`irc: ${this.#error}`);
        this.#running = false;
        this.#socket?.end();
        return;
      case "PRIVMSG":
        await this.#onPrivmsg(line);
        return;
      default:
        return;
    }
  }

  async #onPrivmsg(line: IrcLine): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    const from = nickOf(line.prefix);
    const target = line.params[0] ?? "";
    const text = (line.params[1] ?? "").trim();
    if (!from || !target || !text) return;
    if (from.toLowerCase() === this.#nick.toLowerCase()) return;

    /*
     * The allowlist matches on NICKNAME, and that is weaker than everywhere
     * else in this directory. Discord and Telegram give a numeric account id;
     * IRC gives a nick, which is claimed rather than owned. Without SASL and
     * a registered account, anyone can take a nick the moment its owner
     * disconnects. Said out loud because the gate LOOKS the same as the
     * others and is not: for IRC, treat the allowlist as a courtesy filter,
     * not as authentication.
     */
    if (!this.#allow.has(from.toLowerCase())) {
      ctx.log(`irc: ignored message from non-allowlisted ${from}`);
      return;
    }
    // A channel we were not told to join is not ours to answer in.
    if (target.startsWith("#") && !this.#channels.includes(target)) return;

    const sessionId = ircSessionId(target.startsWith("#") ? target : from, from);

    const command = await runChatCommand(ctx.agent, sessionId, text);
    if (command) {
      await this.send(sessionId, command);
      return;
    }
    if (ctx.askRouter.handleInbound(sessionId, text)) return;

    if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
    ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("IRC"));

    try {
      const { reply } = await runAgent(ctx.agent, sessionId, `[user:${from}] ${text}`, `irc-${this.#seq++}`);
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`irc: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e));
    }
  }
}

registerTransport("irc", () => new IrcConnector());
