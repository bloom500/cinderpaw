/**
 * LeadDesk — the coordination seam between the public-connector lead tools and
 * the live connector that serves them.
 *
 * The lead-handling tools (`escalate_to_human`, `schedule_meeting`) run inside
 * the tool registry, which has no handle on the connector. But two of their
 * effects are inherently connector-side:
 *   1. notifying the human owner (a WhatsApp ping in their chat), and
 *   2. pausing the assistant on a conversation so a human can take over.
 *
 * LeadDesk is a tiny shared object both sides hold: tools call `pause()` /
 * `notify()`; the connector registers a `notifier` (how to ping the owner) and
 * checks `isPaused()` before auto-replying. Pauses auto-expire after a TTL so a
 * forgotten conversation eventually wakes back up.
 */

export type LeadNoticeKind = "lead" | "escalation" | "meeting";

/** A human-facing heads-up the owner should see (delivered by the connector). */
export interface LeadNotice {
  kind: LeadNoticeKind;
  /** The originating connector session, e.g. `whatsapp:4071…@s.whatsapp.net`. */
  sessionId: string;
  /** Best-effort contact handle (phone/email/name) for the human. */
  contact?: string;
  /** One-line human-readable summary. */
  summary: string;
}

export class LeadDesk {
  /** sessionId → wall-clock ms when it was paused. */
  readonly #paused = new Map<string, number>();
  #notifier: ((n: LeadNotice) => void | Promise<void>) | null = null;
  /** Auto-resume safety net: a pause older than this is treated as expired. */
  readonly #pauseTtlMs: number;

  constructor(opts: { pauseTtlMs?: number } = {}) {
    this.#pauseTtlMs = opts.pauseTtlMs ?? 6 * 60 * 60 * 1000; // 6h
  }

  /** Connector registers how to ping the owner. Last registration wins. */
  setNotifier(fn: (n: LeadNotice) => void | Promise<void>): void {
    this.#notifier = fn;
  }

  /** Stop auto-replying on this conversation (a human is taking over). */
  pause(sessionId: string): void {
    this.#paused.set(sessionId, Date.now());
  }

  /** Resume auto-replies on this conversation. */
  resume(sessionId: string): void {
    this.#paused.delete(sessionId);
  }

  /** Whether the assistant should stay quiet on this conversation right now. */
  isPaused(sessionId: string): boolean {
    const at = this.#paused.get(sessionId);
    if (at === undefined) return false;
    if (Date.now() - at > this.#pauseTtlMs) {
      this.#paused.delete(sessionId); // lazy TTL eviction
      return false;
    }
    return true;
  }

  /** Best-effort owner ping. Never throws — a dead notifier must not fail a tool. */
  async notify(n: LeadNotice): Promise<void> {
    try {
      await this.#notifier?.(n);
    } catch {
      // notifier is best-effort; the file record is the durable copy.
    }
  }
}
