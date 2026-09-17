/**
 * Tlon — direct messages on Urbit, through the user's own ship.
 *
 * A ship exposes an HTTP API (Eyre): log in with the `+code`, open a
 * channel, subscribe to the `%chat` agent's `/v3` firehose over SSE, and
 * poke `%chat` to answer. No public address is needed: WE connect to the
 * ship, which is a server the person already runs (or rents from Tlon).
 * The wire is the one OpenClaw's Tlon extension speaks (pokes and paths
 * copied from it), reduced to DMs.
 *
 * Two things a Urbit newcomer will hit, and both are on screen: the access
 * code is `+code` in the ship's dojo (not the master ticket), and a DM from
 * a ship the bot has never spoken to arrives as an INVITE first; we accept
 * it automatically only for allowlisted ships, so a stranger cannot open a
 * conversation by inviting.
 *
 * Written against OpenClaw's code and Urbit's documented channel protocol,
 * not yet against a running ship. The card says so.
 *
 * ponytail: DMs only, text only. Group channels (`%channels` `/v2`) are the
 * next slice; club DMs (multi-ship) are read but not answered.
 */

import {
  connectorErrorMessage,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief, formatForChat } from "./chat-format.ts";
import { registerTransport, type ConnectorContext, type LiveConnector } from "./registry.ts";

const TLON_MAX = 4000;
const REQUEST_TIMEOUT_MS = 30_000;

/** `~sampel-palnet` with the sig, lowercased; "" for anything that is not a ship name. */
export function normalizeShip(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/^~/, "");
  return /^[a-z-]+$/.test(s) && s.length > 0 ? `~${s}` : "";
}

export function tlonSessionId(ship: string): string {
  return `tlon:${ship}`;
}

export function parseTlonSession(sessionId: string): { ship: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 2 || parts[0] !== "tlon" || !parts[1]) return null;
  return { ship: parts[1] };
}

// Urbit's absolute time (@da) is 2^64 units per second, counted from a
// far-past epoch; a message id is `~author/<that number as @ud>`. These
// two constants are from @urbit/aura, which is what OpenClaw uses.
const DA_UNIX_EPOCH = 170141184475152167957503069145530368000n;
const DA_SECOND = 1n << 64n;

/** Unix ms → @da rendered as @ud (decimal with a dot every three digits). */
export function daUdFromUnix(ms: number): string {
  const da = DA_UNIX_EPOCH + (BigInt(Math.floor(ms)) * DA_SECOND) / 1000n;
  return da.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** The text of a chat "story": verses of inline runs, with mentions as ships. */
export function storyText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((verse) => {
      const v = verse as { inline?: unknown[]; block?: unknown };
      if (!Array.isArray(v.inline)) return "";
      return v.inline
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            const o = item as Record<string, unknown>;
            if (typeof o.ship === "string") return o.ship;
            if (typeof o.break === "object") return "\n";
            if (typeof o["inline-code"] === "string") return `\`${o["inline-code"]}\``;
            if (o.link && typeof o.link === "object") return String((o.link as { href?: string }).href ?? "");
            for (const k of ["bold", "italics", "strike"]) if (Array.isArray(o[k])) return storyText([{ inline: o[k] }]);
          }
          return "";
        })
        .join("");
    })
    .filter(Boolean)
    .join("\n");
}

export class TlonConnector implements LiveConnector {
  #ctx: ConnectorContext | null = null;
  #url = "";
  #ship = "";
  #cookie = "";
  #channelId = "";
  #nextId = 1;
  #running = false;
  #live = false;
  #error: string | undefined;
  #allow = new Set<string>();
  #abort: AbortController | null = null;
  #seen = new Set<string>();

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    const field = (k: string) => (ctx.row.metadata?.[k] ?? ctx.secrets[k] ?? "").trim();
    this.#ship = normalizeShip(field("TLON_SHIP"));
    this.#url = field("TLON_URL").replace(/\/+$/, "");
    const code = field("TLON_CODE");
    if (!this.#ship || !/^https?:\/\//.test(this.#url) || !code) {
      throw new Error(
        "tlon: enabled but missing the ship name (~sampel-palnet), the ship URL (where Landscape opens in " +
          "your browser) or the access code (type +code in the ship's dojo; it is NOT the master ticket)",
      );
    }

    // Log in: the cookie is the session. A wrong code is a 400 here, which
    // is the moment to say so rather than at the first unanswered message.
    const login = await fetch(`${this.#url}/~/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: code }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((e: unknown) => {
      throw new Error(`tlon: cannot reach the ship at ${this.#url} (${String(e)}). Is it running, and is the URL the one Landscape opens at?`);
    });
    const setCookie = login.headers.get("set-cookie") ?? "";
    if (!(login.status === 204 || login.ok || login.status === 302) || !setCookie) {
      throw new Error(
        login.status === 400
          ? "tlon: the ship rejected the access code. Type +code in the dojo and paste exactly what it prints"
          : `tlon: the ship answered HTTP ${login.status} to login`,
      );
    }
    this.#cookie = setCookie.split(";")[0]!;

    this.#channelId = `${Date.now()}-cinderpaw`;
    await this.#put([
      { id: this.#nextId++, action: "poke", ship: this.#ship.slice(1), app: "hood", mark: "helm-hi", json: "Cinderpaw connected" },
      { id: this.#nextId++, action: "subscribe", ship: this.#ship.slice(1), app: "chat", path: "/v3" },
    ]);

    this.#allow = new Set((ctx.row.allowlist ?? []).map(normalizeShip).filter(Boolean));
    ctx.log(
      `tlon: logged in to ${this.#ship} at ${this.#url} (${
        this.#allow.size === 0
          ? "0 allowed — NOBODY CAN REACH IT: the allowlist is empty, so every DM is ignored and no invite is accepted. " +
            "Add ship names (~sampel-palnet) to the allowlist to make it answer."
          : `${this.#allow.size} allowed`
      })`,
    );

    ctx.askRouter.registerSender("tlon", (sessionId, text) => this.send(sessionId, text));
    this.#running = true;
    this.#live = true;
    this.#error = undefined;
    void this.#stream();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("tlon");
    this.#abort?.abort();
    if (this.#channelId) await this.#put([{ id: this.#nextId++, action: "delete" }]).catch(() => {});
  }

  health(): ConnectorHealth {
    return this.#live
      ? { live: true }
      : { live: false, ...(this.#error ? { error: this.#error } : {}) };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseTlonSession(sessionId);
    if (!target) return;
    for (const part of formatForChat(text, TLON_MAX)) {
      const sent = Date.now();
      await this.#put([
        {
          id: this.#nextId++,
          action: "poke",
          ship: this.#ship.slice(1),
          app: "chat",
          mark: "chat-dm-action",
          json: {
            ship: target.ship,
            diff: {
              id: `${this.#ship}/${daUdFromUnix(sent)}`,
              delta: { add: { memo: { content: [{ inline: [part] }], author: this.#ship, sent }, kind: null, time: null } },
            },
          },
        },
      ]);
    }
  }

  /** One batch of channel actions (poke / subscribe / ack / delete). */
  async #put(actions: Record<string, unknown>[]): Promise<void> {
    const res = await fetch(`${this.#url}/~/channel/${this.#channelId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: this.#cookie },
      body: JSON.stringify(actions),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`tlon: the ship answered HTTP ${res.status} to a channel ${String(actions[0]?.action)}`);
  }

  /** The SSE stream of channel events, acked one by one; reconnects until stop(). */
  async #stream(backoffMs = 1000): Promise<void> {
    while (this.#running) {
      this.#abort = new AbortController();
      try {
        const res = await fetch(`${this.#url}/~/channel/${this.#channelId}`, {
          headers: { Accept: "text/event-stream", Cookie: this.#cookie },
          signal: this.#abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        this.#live = true;
        this.#error = undefined;
        backoffMs = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            await this.#onFrame(frame);
          }
        }
      } catch (e) {
        if (!this.#running) return;
        this.#live = false;
        this.#error = `tlon: stream lost (${String(e)}), reconnecting`;
        this.#ctx?.log(`${this.#error} in ${Math.round(backoffMs / 1000)}s`);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }

  async #onFrame(frame: string): Promise<void> {
    let eventId: number | null = null;
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("id:")) eventId = Number(line.slice(3).trim());
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (data) {
      try {
        const ev = JSON.parse(data) as { response?: string; json?: unknown };
        if (ev.response === "diff") await this.#onChatEvent(ev.json);
      } catch (e) {
        this.#ctx?.log(`tlon: event not handled: ${String(e)}`);
      }
    }
    if (eventId !== null) await this.#put([{ id: this.#nextId++, action: "ack", "event-id": eventId }]).catch(() => {});
  }

  async #onChatEvent(ev: unknown): Promise<void> {
    // The /v3 firehose sends the DM INVITE list as an array; a record is a message.
    if (Array.isArray(ev)) {
      for (const inv of ev as Array<{ ship?: string }>) {
        const ship = normalizeShip(inv.ship ?? "");
        if (!ship || !this.#allow.has(ship)) continue;
        await this.#put([
          { id: this.#nextId++, action: "poke", ship: this.#ship.slice(1), app: "chat", mark: "chat-dm-rsvp", json: { ship, ok: true } },
        ]).catch((e: unknown) => this.#ctx?.log(`tlon: could not accept the DM invite from ${ship}: ${String(e)}`));
        this.#ctx?.log(`tlon: accepted a DM invite from ${ship}`);
      }
      return;
    }
    const rec = ev as { whom?: string; id?: string; response?: { add?: { essay?: { author?: string; content?: unknown } } } };
    const essay = rec.response?.add?.essay;
    if (!essay || !rec.id) return;
    const whom = normalizeShip(rec.whom ?? "");
    const author = normalizeShip(essay.author ?? "");
    if (!whom) return; // a club (multi-ship) DM: read, not answered
    if (author === this.#ship) return;
    const text = storyText(essay.content).trim();
    if (!text) return;
    if (this.#seen.has(rec.id)) return;
    this.#seen.add(rec.id);
    if (this.#seen.size > 2000) this.#seen.delete(this.#seen.values().next().value!);

    const ctx = this.#ctx;
    if (!ctx) return;
    if (!this.#allow.has(whom)) {
      ctx.log(`tlon: ignored a DM from non-allowlisted ${whom}`);
      return;
    }
    const sessionId = tlonSessionId(whom);
    try {
      const command = await runChatCommand(ctx.agent, sessionId, text);
      if (command) {
        await this.send(sessionId, command);
        return;
      }
      if (ctx.askRouter.handleInbound(sessionId, text)) return;

      if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
      ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("Tlon"));

      const { reply } = await runAgent(ctx.agent, sessionId, `[user:${whom}] ${text}`, `tlon-${rec.id}`);
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`tlon: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e)).catch(() => {});
    }
  }
}

registerTransport("tlon", () => new TlonConnector());
