import type { TaskSuggestion } from "../tools/builtin/suggest-task.ts";

/**
 * A task offered in a chat app (WhatsApp, Telegram...), accepted by the owner
 * with "yes" (spec 4.9). There is no card to press on a phone, so the engine
 * keeps the offer itself.
 *
 * The line that says how to accept is added by code after the agent's reply,
 * so it is always the last thing said. A "yes" counts only while it still is:
 * a later reply or any other message in that chat cancels the offer, because
 * the agent often ends with a question of its own and "yes" then answers that.
 *
 * Only free kinds can be accepted this way (reminders and watches). A task that
 * runs the AI costs money on every run and is turned on at the computer.
 * The match is code, never a model: a page or a message can at most put an
 * offer in front of the owner, the same guarantee as the desktop card.
 */

/** Q3: English and Romanian. More with the app's translations. */
const YES = new Set(["yes", "y", "ok", "okay", "sure", "yeah", "yep", "da", "👍"]);
const ACCEPT_MS = 10 * 60_000;

interface Offer {
  card: TaskSuggestion;
  /** When the accept line went out; null while the reply is still being written. */
  armedAt: number | null;
}

export function isYes(text: string): boolean {
  return YES.has(text.trim().toLowerCase().replace(/[.!\s]+$/u, ""));
}

export interface PhoneOffersDeps {
  /** A chat-app session (the desktop draws a card instead). */
  isChat: (sessionId: string) => boolean;
  /** The allowlisted owner's own chat. */
  isOwner: (sessionId: string) => boolean;
  /**
   * Create the task, like the desktop's Create button. A promise (a price
   * watch, which reads the page first) gives the whole reply instead of the
   * usual "Turned on" line, so a failed read is said, not "Turned on".
   */
  create: (card: TaskSuggestion, sessionId: string) => void | Promise<string>;
  now?: () => number;
}

export class PhoneOffers {
  readonly #offers = new Map<string, Offer>();
  readonly #o: PhoneOffersDeps;

  constructor(o: PhoneOffersDeps) {
    this.#o = o;
  }

  /** suggest_task ran here. True: kept as a phone offer (no card is drawn). */
  offer(sessionId: string, card: TaskSuggestion): boolean {
    if (!this.#o.isChat(sessionId)) return false;
    this.#offers.set(sessionId, { card, armedAt: null });
    return true;
  }

  /** The agent's reply in `sessionId` is about to go out: the line to add after it, if any. */
  tail(sessionId: string): string | null {
    const o = this.#offers.get(sessionId);
    if (!o) return null;
    if (o.armedAt !== null || o.card.kind === "agent") {
      // A newer reply: the offer is no longer the last thing said. An agent
      // task is only told about, never accepted here.
      this.#offers.delete(sessionId);
      if (o.armedAt !== null) return null;
      return `"${o.card.title}", ${lower(o.card.when)}. This one uses the AI each time it runs, so it costs money: open Cinderpaw on your computer to turn it on.`;
    }
    o.armedAt = this.#now();
    const seen = o.card.seenPrice !== undefined ? ` I saw ${o.card.seenPrice} on the page.` : "";
    return `"${o.card.title}", ${lower(o.card.when)}.${seen} Reply "yes" to turn it on.`;
  }

  /** Something else was said in that chat: a "yes" now answers that, not the offer. */
  said(sessionId: string): void {
    if (this.#offers.get(sessionId)?.armedAt != null) this.#offers.delete(sessionId);
  }

  /**
   * A message came in. Returns the confirmation to send when it accepted the
   * offer (the agent then does not run), or null (the agent gets it as usual).
   */
  answer(sessionId: string, text: string): string | Promise<string> | null {
    const o = this.#offers.get(sessionId);
    if (!o || o.armedAt === null || !this.#o.isOwner(sessionId)) return null;
    this.#offers.delete(sessionId); // whatever they said, the offer was answered
    if (!isYes(text) || this.#now() - o.armedAt > ACCEPT_MS) return null;
    const created = this.#o.create(o.card, sessionId);
    if (created) return created;
    return `✅ Turned on: "${o.card.title}", ${lower(o.card.when)}. You can change it in Cinderpaw, under Tasks.`;
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
