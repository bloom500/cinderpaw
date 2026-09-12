/**
 * What a THIRD-PARTY channel plugin is handed, and what it can never reach.
 *
 * We already have a transport contract (`registry.ts`: `ConnectorContext` +
 * `LiveConnector`) and most of it is right — the host resolves secrets out of
 * the vault so a transport never touches it, and `row` arrives without secret
 * values. That contract was written for transports WE wrote. This one is for
 * code we did not write, arriving from a package, carrying a bot token and
 * reading messages from strangers.
 *
 * The difference is not politeness. It is four capabilities that the existing
 * context hands over without saying so:
 *
 *  1. PROFILE MINTING. `ctx.agent.registerProfile(id, { systemPrompt })` with
 *     no `allowedTools` compiles to `allowed: null`, which
 *     `setSessionProfile` reads as persona-only — "still the owner, in a
 *     different voice" — and `markSessionRestricted(sessionId, false)`. Two
 *     calls and every stranger on that plugin's platform is the owner. Our
 *     own WhatsApp transport uses this correctly at connectors.ts:1578; a
 *     third party has no reason to be trusted with it. Here the host mints
 *     the profile from the manifest and the plugin receives sessions already
 *     bound, with no way to rebind them.
 *
 *  2. NETWORK. Transports import platform SDKs and open their own sockets.
 *     Every TOOL goes through the egress proxy (allowlisted hosts, no
 *     loopback, no private ranges, rate limits, audit); a transport goes
 *     nowhere near it. `hosts` below is declared in the manifest and the
 *     plugin is handed a bound fetch for them.
 *
 *  3. FILESYSTEM. Nothing in the current context mentions the disk, and the
 *     WhatsApp transport writes `whatsapp-qr.json` into the profile dir. A
 *     plugin gets one scoped directory and is told where it is.
 *
 *  4. EXTERNAL BINARIES. Signal is a `signal-cli` linked device over local
 *     RPC. Undeclared, that is a connector that silently does nothing on a
 *     machine that never installed it. Declared, the host can say so on
 *     screen before the user enables it.
 *
 * CEILING, stated plainly because the contract is weaker than it reads: a
 * bound fetch does not contain a bundled SDK. `@slack/bolt`, `grammy` and
 * `discord.js` open their own connections and will not route through
 * anything we hand them. For in-tree ports (our plan for all 21) that is
 * fine — we write the code and the declaration is a review checklist we can
 * actually enforce. For a plugin loaded from a package at runtime it is not
 * containment, and the only real answer is the separate process we already
 * have in `egress/process-sandbox.ts`. Do not let this file's existence be
 * read as "third-party packages are now safe to load".
 *
 * ponytail: types plus one factory, no plugin framework. The manifest is
 * data we already extracted (scripts/openclaw/openclaw-channels.json); the
 * host reads it. A loader, a registry and a lifecycle manager can be written
 * the day a plugin actually arrives from outside the tree.
 */

import type { ConnectorHealth } from "./connectors.ts";
import type { OutboundEvent } from "../types.ts";

/**
 * What a channel plugin declares about itself, beyond OpenClaw's own channel
 * block (id, label, setup fields, configuredState — all already extracted).
 *
 * These four exist because their manifest has no equivalent: theirs declares
 * what a channel NEEDS FROM THE USER, ours also has to declare what it needs
 * from the MACHINE. A field left empty is a capability denied, not a
 * capability unrestricted — the direction that matters on a fresh install,
 * where every one of these is empty.
 */
export interface PluginCapabilities {
  /** Hostnames the plugin may reach. Empty = no network. */
  hosts: readonly string[];
  /** True when the plugin needs its own scoped directory on disk. */
  storage: boolean;
  /**
   * External programs the plugin requires (e.g. `signal-cli`). The host
   * checks these BEFORE enabling the connector and tells the user what is
   * missing, by name, on screen.
   */
  binaries: readonly string[];
  /**
   * Tool names sessions on this channel may call. Empty = the channel can
   * talk and nothing else, which is the correct default for a surface whose
   * participants are strangers.
   */
  tools: readonly string[];
}

/** One inbound message, normalized. Whatever the platform called it. */
export interface InboundMessage {
  /** Stable per-speaker id on the platform. Never reused across platforms. */
  speakerId: string;
  /** Room, channel or chat. `null` for a direct message. */
  roomId: string | null;
  text: string;
  /** data: URLs, already read by the host. See transports/attachments.ts. */
  images?: readonly string[];
  /** True when the platform says this speaker is the connector's owner. */
  isOwner: boolean;
}

/**
 * A conversation the plugin may drive. This is the whole of its access to
 * the agent: no profile registration, no session rebinding, no way to reach
 * another channel's sessions.
 *
 * The host created it already bound to the right profile, so there is no
 * order of calls a plugin can choose that makes a stranger the owner.
 */
export interface PluginSession {
  /** Send the speaker's message to the agent and stream events back. */
  ask(text: string, messageId: string, emit: (e: OutboundEvent) => void, images?: readonly string[]): Promise<string>;
  /** Start this conversation over. Backs `/new`. */
  reset(): void;
}

/** Everything the host gives a third-party channel plugin. */
export interface PluginHost {
  /**
   * Credentials, resolved from the vault by the host, keyed by the manifest's
   * field key. Unchanged from `ConnectorContext.secrets` and for the same
   * reason: a plugin that never reads the vault has no path that writes one.
   */
  readonly secrets: Readonly<Record<string, string>>;
  /** Non-secret config: allowlist, rooms, mode. */
  readonly config: Readonly<Record<string, unknown>>;
  /**
   * A conversation for one speaker, already bound to this channel's profile.
   * Returns null when the speaker is not allowed to be answered — the host
   * owns the allowlist, not the plugin, so a plugin cannot decide to answer
   * someone the user never listed.
   */
  session(msg: InboundMessage): PluginSession | null;
  /** Bound to the manifest's declared `hosts`. Anything else is refused. */
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** This plugin's own directory. Absent unless it declared `storage`. */
  readonly storageDir?: string;
  /** Resolved paths of declared binaries. Absent ones are simply not here. */
  readonly binaries: Readonly<Record<string, string>>;
  readonly log: (line: string) => void;
}

/** What a channel plugin must implement. Deliberately the same four verbs as
 *  `LiveConnector`, so an in-tree transport and a plugin stay interchangeable
 *  and we do not end up maintaining two lifecycles. */
export interface ChannelPlugin {
  start(host: PluginHost): Promise<void>;
  stop(): Promise<void>;
  health(): ConnectorHealth;
  send(speakerId: string, text: string): Promise<void>;
}

/**
 * The capabilities of a plugin that declared nothing.
 *
 * Exported and used as the base of every resolution, rather than living as
 * `?? []` scattered through the host: a capability the manifest does not
 * mention has to arrive here as denied, on the first run, before anyone has
 * configured anything. An empty allowlist that means "allow everything" has
 * shipped on this repo before.
 */
export const NO_CAPABILITIES: PluginCapabilities = {
  hosts: [],
  storage: false,
  binaries: [],
  tools: [],
};

/**
 * Read a manifest's capability block into the real thing, denying by default.
 *
 * Takes `unknown` because the input is a JSON file from a package we did not
 * write: anything that is not a list of strings is not a narrower permission,
 * it is a malformed one, and it resolves to none.
 */
export function resolveCapabilities(declared: unknown): PluginCapabilities {
  const d = (declared ?? {}) as Partial<Record<keyof PluginCapabilities, unknown>>;
  const strings = (v: unknown): readonly string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  return {
    hosts: strings(d.hosts),
    storage: d.storage === true,
    binaries: strings(d.binaries),
    tools: strings(d.tools),
  };
}
