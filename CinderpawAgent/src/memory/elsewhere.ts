/**
 * One Cinderpaw across every chat. Each chat app and each desktop chat is its
 * own session, so the desktop answered "I can't confirm that" about a WhatsApp
 * conversation it had held ten minutes earlier (1 Nov 2026). This builds a
 * per-turn note: which chat apps are connected right now, and the last lines
 * the owner exchanged with the agent in their OTHER chats.
 *
 * Only the owner's chats are read or written to. A friend on the allowlist, or
 * a public lead, has their own session and never sees the owner's words, nor
 * do their words reach the owner's note.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cinderpawHome } from "../config.ts";
import type { EpisodicEvent } from "../types.ts";

/** How far back another chat still counts as "just now". */
const WINDOW_MS = 6 * 60 * 60 * 1000;
const PER_CHAT = 4;
const MAX_CHATS = 3;
const CLIP = 240;

const owned = new Set<string>();

/**
 * A connector names a session as the owner's own (WhatsApp: "Message
 * yourself"). In memory on purpose: the connector marks it again on every start.
 */
export function markOwnerChat(sessionId: string): void {
  owned.add(sessionId);
}

const appOwners = new Map<string, string>();

/**
 * Who the owner is on every chat app: the first person on its allowlist, the
 * same rule `notifyOwner` pages. Set by ConnectorManager on every config load,
 * so one rule covers all twenty apps instead of a check written per app.
 */
export function setAppOwners(owners: ReadonlyMap<string, string>): void {
  appOwners.clear();
  for (const [app, id] of owners) appOwners.set(app, norm(id));
}

/** One spelling per person: "+40 712..." and "40712...@s.whatsapp.net" match. */
function norm(id: string): string {
  const s = id.trim().toLowerCase().replace(/@.*$/, "");
  const digits = s.replace(/[\s()+-]/g, "");
  return /^\d{6,}$/.test(digits) ? digits : s;
}

/**
 * Every transport names a session `<app>:...:<speaker>`, the speaker last
 * (Teams base64url-encodes it, Matrix URI-encodes it).
 */
function speakerOf(sessionId: string): [string, string] | null {
  const parts = sessionId.split(":");
  if (parts.length < 2) return null;
  const app = parts[0]!;
  let who = parts[parts.length - 1]!;
  try {
    who = app === "msteams" ? Buffer.from(who, "base64url").toString() : decodeURIComponent(who);
  } catch {
    // a malformed id stays as it is and simply matches nobody
  }
  return [app, norm(who)];
}

const DESKTOP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a chat the owner is having: a desktop chat, or one where the owner is the speaker. */
export function ownsChat(sessionId: string): boolean {
  if (owned.has(sessionId) || DESKTOP.test(sessionId)) return true;
  const s = speakerOf(sessionId);
  const owner = s ? appOwners.get(s[0]) : undefined;
  return !!owner && owner === s![1];
}

/**
 * A chat only the owner reads: the note must never be answered into a group.
 * ponytail: apps whose private-chat id gives no sign (Matrix, Teams rooms) count
 * as groups; they still FEED the note, they just never receive it.
 */
function privateChat(sessionId: string): boolean {
  if (owned.has(sessionId) || DESKTOP.test(sessionId)) return true;
  const p = sessionId.split(":");
  if (p[0] === "whatsapp") return !sessionId.endsWith("@g.us");
  if (p.length === 2) return true; // one session per person: SMS, Signal, Nostr...
  return p[1] === "dm" || p[1] === p[2] || (p[0] === "slack" && p[1]!.startsWith("D"));
}

/** This chat gets the note: it is the owner's, and nobody else reads the answer. */
export function hearsElsewhere(sessionId: string): boolean {
  return ownsChat(sessionId) && privateChat(sessionId);
}

const NAMES: Record<string, string> = {
  whatsapp: "WhatsApp", discord: "Discord", telegram: "Telegram", slack: "Slack", signal: "Signal",
  imessage: "iMessage", sms: "SMS", matrix: "Matrix", msteams: "Microsoft Teams", googlechat: "Google Chat",
};
const nameOf = (id: string) => NAMES[id] ?? id;
const placeOf = (sessionId: string) => (DESKTOP.test(sessionId) ? "another desktop chat" : nameOf(sessionId.split(":")[0]!));

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
}

/** The chat apps that are switched on, and whether each one is really connected. */
export function connectorLine(file = join(cinderpawHome(), "connector-health.json")): string {
  if (!existsSync(file)) return "";
  try {
    const { connectors } = JSON.parse(readFileSync(file, "utf8")) as {
      connectors?: Record<string, { live: boolean; error?: string }>;
    };
    const rows = Object.entries(connectors ?? {}).map(([id, h]) =>
      h.live ? `${nameOf(id)} connected` : `${nameOf(id)} NOT connected${h.error ? ` (${h.error.slice(0, 120)})` : ""}`,
    );
    return rows.length ? `- Chat apps switched on: ${rows.join("; ")}. This is live: trust it over anything said earlier.` : "";
  } catch {
    return ""; // a half-written file costs one turn without the line
  }
}

/** The owner's other chats in the last few hours, newest first, a few lines each. */
export function elsewhereNote(
  sessionId: string,
  since: (ts: number, except: string) => EpisodicEvent[],
  now = Date.now(),
): string {
  const chats = new Map<string, EpisodicEvent[]>();
  for (const ev of since(now - WINDOW_MS, sessionId)) {
    if (!ownsChat(ev.sessionId)) continue;
    const lines = chats.get(ev.sessionId) ?? [];
    if (lines.length < PER_CHAT && (lines.length > 0 || chats.size < MAX_CHATS)) chats.set(ev.sessionId, [...lines, ev]);
  }
  if (chats.size === 0) return "";
  const blocks = [...chats].map(([id, evs]) => {
    const lines = evs
      .reverse()
      .map((e) => `  ${e.role === "user" ? "Them" : "You"}: ${e.content.replace(/\s+/g, " ").slice(0, CLIP)}`);
    return `- In ${placeOf(id)}, ${ago(now - evs[evs.length - 1]!.timestamp)}:\n${lines.join("\n")}`;
  });
  return [
    "## Your other chats with this person",
    "The same person talked to you elsewhere recently. It was you: when they mention it, you remember it. Do not recite this unasked.",
    ...blocks,
  ].join("\n");
}
