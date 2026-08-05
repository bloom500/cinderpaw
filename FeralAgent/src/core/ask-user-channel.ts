/**
 * Channel-ask — ask_user over messaging connectors (Discord/Slack/WhatsApp).
 *
 * The AskUserBridge emits `ask_user` events to the DESKTOP transport, which a
 * user chatting on Discord never sees: the tool stalled for the full timeout
 * and silently auto-picked the recommended option. This module closes that
 * hole: for connector sessions the questions are sent as a plain text message
 * IN the channel, and the user's next reply resolves them.
 *
 * Split:
 *   - `formatQuestionsForChat` / `parseChannelAnswers` — pure, unit-tested.
 *   - `ChannelAskRouter` — the delegate the AskUserBridge consults. Connectors
 *     register a text sender per session prefix ("discord", "slack",
 *     "whatsapp") while connected; their inbound handlers call
 *     `handleInbound()` FIRST so a reply to a pending question answers the
 *     question instead of starting a new agent turn.
 *
 * One pending ask per session: a second ask while one is pending cancels the
 * first (the tool surfaces the cancel; parallel asks in one chat would be
 * unanswerable anyway). Timeout mirrors the bridge default so the ask_user
 * tool's auto-resolve path behaves identically on every surface.
 */

import type { AskUserAnswer, AskUserQuestion } from "../types.ts";
import { AskUserTimeoutError } from "../types.ts";

/** Sends one plain-text message into the chat behind a sessionId. */
export type ChannelSender = (sessionId: string, text: string) => Promise<void>;

/** Default matches AskUserBridgeImpl's DEFAULT_CONFIG. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Render 1-4 questions as one compact chat message. */
export function formatQuestionsForChat(questions: AskUserQuestion[]): string {
  const lines: string[] = ["❓ I need your input:"];
  const multi = questions.length > 1;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    lines.push(multi ? `${i + 1}. ${q.question}` : q.question);
    for (let j = 0; j < q.options.length; j++) {
      const o = q.options[j]!;
      const star = o.recommended ? " ⭐" : "";
      const desc = o.description ? ` — ${o.description}` : "";
      lines.push(`  ${j + 1}) ${o.label}${star}${desc}`);
    }
  }
  lines.push(
    multi
      ? `Reply with one option number per question, comma-separated (e.g. "1, 2") — or just type your answer.`
      : `Reply with the option number, or just type your answer.`,
  );
  return lines.join("\n");
}

/**
 * Parse a chat reply into answers. Per question token (comma/newline split
 * when there are several questions; the whole reply for one):
 *   - "2" (or "2 3" / "2+3" for multiSelect) → those option labels
 *   - text matching an option label (case-insensitive) → that label
 *   - anything else → free-form `customText`
 * Missing tokens fall back to the recommended (or first) option so a short
 * reply to a multi-question ask still resolves every question.
 */
export function parseChannelAnswers(
  questions: AskUserQuestion[],
  reply: string,
): AskUserAnswer[] {
  const tokens =
    questions.length > 1
      ? reply.split(/[,\n]+/).map((t) => t.trim())
      : [reply.trim()];

  return questions.map((q, i) => {
    const token = tokens[i]?.trim() ?? "";
    if (!token) {
      const fallback = q.options.find((o) => o.recommended) ?? q.options[0];
      return { question: q.question, selected: fallback ? [fallback.label] : [] };
    }

    // Numeric selection(s): "2", "2 3", "2+3".
    const parts = token.split(/[+\s]+/).filter(Boolean);
    if (parts.length > 0 && parts.every((p) => /^\d+$/.test(p))) {
      const picked = parts
        .map((p) => q.options[Number(p) - 1]?.label)
        .filter((l): l is string => typeof l === "string");
      if (picked.length > 0) {
        return {
          question: q.question,
          selected: q.multiSelect ? picked : picked.slice(0, 1),
        };
      }
      // Numbers out of range → treat as free text below.
    }

    const byLabel = q.options.find(
      (o) => o.label.toLowerCase() === token.toLowerCase(),
    );
    if (byLabel) {
      return { question: q.question, selected: [byLabel.label] };
    }
    return { question: q.question, selected: [], customText: token };
  });
}

interface PendingChannelAsk {
  resolve: (answers: AskUserAnswer[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  questions: AskUserQuestion[];
}

export class ChannelAskRouter {
  readonly #senders = new Map<string, ChannelSender>();
  readonly #pending = new Map<string, PendingChannelAsk>();
  readonly #timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.#timeoutMs = timeoutMs;
  }

  /** Connector lifecycle: register a sender for a session prefix on start… */
  registerSender(prefix: string, sender: ChannelSender): void {
    this.#senders.set(prefix, sender);
  }

  /** …and drop it on stop. Pending asks for that prefix are cancelled. */
  unregisterSender(prefix: string): void {
    this.#senders.delete(prefix);
    for (const [sessionId] of this.#pending) {
      if (sessionId.startsWith(`${prefix}:`)) {
        this.#cancel(sessionId, `${prefix} connector stopped`);
      }
    }
  }

  /** True when this router can ask in the channel behind `sessionId`. */
  canHandle(sessionId: string): boolean {
    const prefix = sessionId.split(":", 1)[0] ?? "";
    return this.#senders.has(prefix);
  }

  /**
   * Say something in-channel without asking anything, and without a turn to ride
   * along with.
   *
   * What needs it: a run whose process died is picked back up at boot, or given
   * up on there. Either way the person who started it is not mid-conversation,
   * so there is no reply to attach the report to — but they are owed one, and a
   * run that ends in silence is the whole failure being fixed.
   *
   * Returns false instead of throwing when it could not be said: a connector
   * that is disabled, not yet connected, or answering 401 must not take down a
   * boot-time pass that still has other runs to deal with. The caller logs it.
   */
  async notify(sessionId: string, text: string): Promise<boolean> {
    const prefix = sessionId.split(":", 1)[0] ?? "";
    const sender = this.#senders.get(prefix);
    if (!sender) return false;
    try {
      await sender(sessionId, text);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ask in-channel. Sends the formatted questions, then waits for
   * `handleInbound` (or times out with AskUserTimeoutError, matching the
   * bridge so the tool's auto-resolve kicks in identically).
   */
  async ask(questions: AskUserQuestion[], sessionId: string): Promise<AskUserAnswer[]> {
    const prefix = sessionId.split(":", 1)[0] ?? "";
    const sender = this.#senders.get(prefix);
    if (!sender) {
      throw new Error(`no channel sender for session ${sessionId}`);
    }
    // Replace-not-queue: a second ask in the same chat would be unanswerable.
    this.#cancel(sessionId, "superseded by a newer question");

    // Register the pending entry BEFORE the (async) send: two back-to-back
    // asks otherwise interleave at the send await and the first entry is
    // silently overwritten instead of cancelled — an unsettled Promise and
    // an orphaned timer.
    const answered = new Promise<AskUserAnswer[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(sessionId);
        void sender(
          sessionId,
          "⏳ No answer — going with the recommended option.",
        ).catch(() => {});
        reject(new AskUserTimeoutError(sessionId, this.#timeoutMs));
      }, this.#timeoutMs);
      this.#pending.set(sessionId, { resolve, reject, timer, questions });
    });
    // Mark the rejection path observed: a supersede/cancel can reject before
    // the caller adopts the promise (it is suspended at the send await), and
    // that no-handler window fires unhandledRejection in production.
    answered.catch(() => {});

    try {
      await sender(sessionId, formatQuestionsForChat(questions));
    } catch (e) {
      this.#cancel(sessionId, `channel send failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return answered;
  }

  /**
   * Called by connector inbound handlers BEFORE running the agent. Returns
   * true when `text` answered a pending question (the caller must NOT start
   * an agent turn for it).
   */
  handleInbound(sessionId: string, text: string): boolean {
    const p = this.#pending.get(sessionId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.#pending.delete(sessionId);
    p.resolve(parseChannelAnswers(p.questions, text));
    return true;
  }

  /** Diagnostic: number of chats currently waiting on an answer. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  #cancel(sessionId: string, reason: string): void {
    const p = this.#pending.get(sessionId);
    if (!p) return;
    clearTimeout(p.timer);
    this.#pending.delete(sessionId);
    p.reject(new Error(`ask_user in ${sessionId} cancelled: ${reason}`));
  }
}
