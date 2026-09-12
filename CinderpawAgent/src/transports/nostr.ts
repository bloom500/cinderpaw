/**
 * Nostr — the one with no server to be banned from.
 *
 * Every other connector here has an operator: Telegram can close a bot,
 * Discord can close an account, a Mattermost admin can revoke a token. Nostr
 * has none. The identity is a keypair you hold, and a relay is a dumb pipe you
 * can swap for another one mid-sentence. That changes what this file has to do:
 * there is no login and nothing to authenticate against, so the work is signing
 * events correctly and staying connected to several relays at once.
 *
 * Messages are NIP-04 encrypted DMs (kind 4), which is what OpenClaw's channel
 * uses and what every Nostr client can read today. NIP-04 is formally
 * deprecated in favour of NIP-17: it leaks metadata, because who talks to whom
 * and when is in the clear even though the text is not. It is here because a
 * message nobody's client can open is not privacy, it is silence. When enough
 * clients speak NIP-17, this is the file that changes.
 *
 * The dependency is deliberate and it is the only one in this series so far.
 * Signing a Nostr event is a BIP-340 Schnorr signature over secp256k1, which
 * `node:crypto` does not implement, and hand-rolling a signature scheme is the
 * one thing laziness must never reach for. `nostr-tools` is Unlicense, so it
 * adds no obligation to the binary.
 *
 * ponytail: text only, DMs only. No public notes, no threads, no reactions,
 * no NIP-05 name lookups. The agent answers whoever wrote to it, which is the
 * same thing every other connector in this directory does.
 */

import { finalizeEvent, getPublicKey, nip04, nip19, SimplePool, type Event } from "nostr-tools";
import {
  connectorErrorMessage,
  runAgent,
  runChatCommand,
  type ConnectorHealth,
} from "./connectors.ts";
import { chatStyleBrief, formatForChat } from "./chat-format.ts";
import { registerTransport, type ConnectorContext, type LiveConnector } from "./registry.ts";

/**
 * Nostr sets no length limit; relays do, and most reject somewhere around
 * 64 KB. NIP-04 ciphertext is base64 over AES, so it runs about a third longer
 * than the text it carries. 8000 characters leaves that headroom with room to
 * spare and keeps a long answer readable in clients that do not wrap well.
 */
const NOSTR_MAX = 8000;

/** Kind 4 is the encrypted direct message. */
const KIND_DM = 4;

/**
 * Where to listen when the user has not said. A fresh install has no relay
 * list, and a Nostr client with no relays is not "unconfigured", it is deaf:
 * it connects to nothing, hears nothing, and reports no error, because nothing
 * failed. These four are long-running public relays that accept reads and
 * writes without an account. The user can replace them, and should, but the
 * default has to be a working one.
 */
const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://relay.primal.net",
];

export function nostrSessionId(pubkey: string): string {
  return `nostr:${pubkey}`;
}

export function parseNostrSession(sessionId: string): { pubkey: string } | null {
  const parts = sessionId.split(":");
  if (parts.length !== 2 || parts[0] !== "nostr") return null;
  return { pubkey: parts[1]! };
}

/**
 * Accept a key in either form a person can actually be holding.
 *
 * Clients show and export `nsec1...` (NIP-19 bech32); developer tooling and
 * env vars carry raw 64-character hex. Someone pasting what their client gave
 * them must not be told their key is invalid, so both are read here rather
 * than in a setup wizard that only one of the four entry points goes through.
 */
export function decodeSecretKey(raw: string): Uint8Array {
  const key = raw.trim();
  if (!key) throw new Error("nostr: no private key");
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    return Uint8Array.from(key.match(/../g)!.map((b) => parseInt(b, 16)));
  }
  // Any NIP-19 code, not only `nsec`. The mistake people actually make is
  // pasting the PUBLIC key, and `npub1...` does not start with "nsec", so
  // checking for the right prefix alone sends them to the generic message
  // below — which tells them the format is wrong when the format is fine and
  // it is the wrong key. Decoding first means the error can name what they
  // pasted.
  try {
    const decoded = nip19.decode(key);
    if (decoded.type === "nsec") return decoded.data;
    throw new Error(
      `nostr: that is an ${decoded.type} (${decoded.type === "npub" ? "your PUBLIC key" : "not a key"}), not a private key — Cinderpaw needs the nsec1... one your client calls the private or secret key`,
    );
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("nostr:")) throw e;
  }
  throw new Error(
    "nostr: the private key is neither an nsec1... key nor 64 hex characters — copy it from your client's key export",
  );
}

/**
 * The allowlist is written by a human, so it holds whatever their client
 * showed them: `npub1...`. The wire only ever carries hex, so the comparison
 * would silently never match. Normalising both sides here is the difference
 * between an allowlist that works and one that rejects everybody in silence.
 */
export function normalisePubkey(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith("npub")) {
    try {
      const decoded = nip19.decode(v);
      return decoded.type === "npub" ? decoded.data : null;
    } catch {
      return null;
    }
  }
  return /^[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : null;
}

export function parseRelayUrls(raw: string | undefined): string[] {
  const listed = (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return listed.length > 0 ? listed : [...DEFAULT_RELAYS];
}

export class NostrConnector implements LiveConnector {
  #ctx: ConnectorContext | null = null;
  #pool: SimplePool | null = null;
  #sub: { close: () => void } | null = null;
  #secret: Uint8Array | null = null;
  #self = "";
  #relays: string[] = [];
  #allow = new Set<string>();
  #live = false;
  #error: string | undefined;
  /**
   * Relays replay history, and several of them replay the SAME message. Kind 4
   * events carry an id, so remembering the ids already handled is what stops
   * the agent answering one question four times.
   */
  #seen = new Set<string>();

  async start(ctx: ConnectorContext): Promise<void> {
    this.#ctx = ctx;
    const rawKey = (ctx.secrets.NOSTR_PRIVATE_KEY ?? "").trim();
    if (!rawKey) {
      throw new Error("nostr: enabled but no private key (expected secrets.NOSTR_PRIVATE_KEY)");
    }
    this.#secret = decodeSecretKey(rawKey);
    this.#self = getPublicKey(this.#secret);

    // Relay addresses are configuration, not credentials — same call as the
    // Matrix homeserver, and for the same reason: a public wss:// URL in the
    // OS keychain is hidden from the person who typed it.
    const rawRelays = ctx.row.metadata?.NOSTR_RELAY_URLS ?? ctx.secrets.NOSTR_RELAY_URLS;
    this.#relays = parseRelayUrls(rawRelays);

    this.#allow = new Set(
      (ctx.row.allowlist ?? []).map(normalisePubkey).filter((k): k is string => k !== null),
    );
    const unreadable = (ctx.row.allowlist ?? []).filter((k) => normalisePubkey(k) === null);
    if (unreadable.length > 0) {
      // Said out loud rather than dropped: an entry that looks like a key but
      // is not one would otherwise fail exactly like a stranger's message.
      ctx.log(
        `nostr: ${unreadable.length} allowlist entr${unreadable.length === 1 ? "y is" : "ies are"} neither an npub nor 64 hex characters and will never match: ${unreadable.join(", ")}`,
      );
    }

    this.#pool = new SimplePool();
    this.#sub = this.#pool.subscribeMany(
      this.#relays,
      // `since` is now: the inbox is not history. Without it the first
      // connection replays every DM the relays still hold and the agent
      // answers a year of messages at once.
      { kinds: [KIND_DM], "#p": [this.#self], since: Math.floor(Date.now() / 1000) },
      {
        onevent: (event) => void this.#onEvent(event),
        onclose: (reasons) => {
          // SimplePool reconnects on its own; this only records why health
          // went quiet, so the reason reaches a screen instead of a log.
          this.#error = reasons.map((r) => `${r.url}: ${r.reason}`).join("; ") || undefined;
        },
      },
    );

    ctx.askRouter.registerSender("nostr", (sessionId, text) => this.send(sessionId, text));
    this.#live = true;
    this.#error = undefined;
    ctx.log(
      `nostr: listening as ${nip19.npubEncode(this.#self)} on ${this.#relays.length} relay${
        this.#relays.length === 1 ? "" : "s"
      } (${this.#allow.size} allowed${
        this.#allow.size === 0 ? " — nobody can talk to it until you add someone" : ""
      })`,
    );
  }

  async stop(): Promise<void> {
    this.#live = false;
    this.#ctx?.askRouter.unregisterSender("nostr");
    try {
      this.#sub?.close();
    } catch {
      // already closed
    }
    this.#sub = null;
    try {
      this.#pool?.destroy();
    } catch {
      // already gone
    }
    this.#pool = null;
    this.#seen.clear();
  }

  health(): ConnectorHealth {
    if (!this.#live) {
      return { live: false, ...(this.#error ? { error: this.#error } : {}) };
    }
    // One relay answering is enough to send and receive, so health is not "all
    // of them". Reporting live on zero would be a lie the user cannot see
    // through, because nothing else about Nostr fails loudly.
    const statuses = this.#pool?.listConnectionStatus();
    const up = statuses ? [...statuses.values()].filter(Boolean).length : 0;
    if (statuses && statuses.size > 0 && up === 0) {
      return { live: false, error: `no relay is reachable (tried ${this.#relays.join(", ")})` };
    }
    return { live: true };
  }

  async send(sessionId: string, text: string): Promise<void> {
    const target = parseNostrSession(sessionId);
    const secret = this.#secret;
    const pool = this.#pool;
    if (!target || !secret || !pool) return;
    for (const part of formatForChat(text, NOSTR_MAX)) {
      const event = finalizeEvent(
        {
          kind: KIND_DM,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["p", target.pubkey]],
          content: nip04.encrypt(secret, target.pubkey, part),
        },
        secret,
      );
      // Publishing returns one promise per relay and some always reject:
      // a relay that is down, rate-limiting, or refusing writes from unknown
      // keys is normal. One acceptance is delivery, so a rejection is not an
      // error to raise at the agent — but a total failure is.
      const results = await Promise.allSettled(pool.publish(this.#relays, event));
      if (!results.some((r) => r.status === "fulfilled")) {
        const why = results
          .map((r) => (r.status === "rejected" ? String(r.reason) : ""))
          .filter(Boolean)
          .join("; ");
        throw new Error(`nostr: no relay accepted the message${why ? ` (${why})` : ""}`);
      }
    }
  }

  async #onEvent(event: Event): Promise<void> {
    const ctx = this.#ctx;
    const secret = this.#secret;
    if (!ctx || !secret) return;
    if (event.pubkey === this.#self) return; // our own reply, echoed back
    if (this.#seen.has(event.id)) return;
    this.#seen.add(event.id);
    // Bounded: relays replay, and an unbounded set is a slow leak on a
    // connector meant to run for months.
    if (this.#seen.size > 5000) {
      this.#seen = new Set([...this.#seen].slice(-2500));
    }

    if (!this.#allow.has(event.pubkey)) {
      ctx.log(`nostr: ignored message from non-allowlisted ${nip19.npubEncode(event.pubkey)}`);
      return;
    }

    let text: string;
    try {
      text = nip04.decrypt(secret, event.pubkey, event.content).trim();
    } catch (e) {
      // A DM we cannot decrypt is one encrypted to a different key, or a
      // NIP-17 message we do not speak yet. Neither is a fault to retry.
      ctx.log(`nostr: could not decrypt a message from ${nip19.npubEncode(event.pubkey)}: ${String(e)}`);
      return;
    }
    if (!text) return;

    const sessionId = nostrSessionId(event.pubkey);

    const command = await runChatCommand(ctx.agent, sessionId, text);
    if (command) {
      await this.send(sessionId, command);
      return;
    }
    if (ctx.askRouter.handleInbound(sessionId, text)) return;

    if (ctx.personaProfileId) ctx.agent.setSessionProfile?.(sessionId, ctx.personaProfileId);
    ctx.agent.setSessionSurface?.(sessionId, chatStyleBrief("Nostr"));

    try {
      const { reply } = await runAgent(
        ctx.agent,
        sessionId,
        `[user:${event.pubkey}] ${text}`,
        `nostr-${event.id}`,
      );
      await this.send(sessionId, reply || "(no response)");
    } catch (e) {
      ctx.log(`nostr: agent error: ${String(e)}`);
      await this.send(sessionId, connectorErrorMessage(e));
    }
  }
}

registerTransport("nostr", () => new NostrConnector());
