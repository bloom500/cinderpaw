/**
 * Cowork runtime (S3.5) — boots the reactive worker loop for every
 * configured agent and makes A2A activity VISIBLE through the transport.
 *
 * Fresh-install discipline: zero agents configured ⇒ `tick()` walks an
 * empty list ⇒ zero turns, zero events, zero cost. The feature does not
 * exist until the user creates their first cowork agent.
 *
 * Design points locked 2026-08-25:
 * - Strictly reactive: the timer only DRAINS inboxes; nothing invents work.
 * - Context compounds: one persistent session per agent (`cowork:<id>`),
 *   mirroring Grok's named-teammate model rather than cron's throwaway
 *   sessions. Eviction policy is a later concern.
 * - Loop guard: an agent's reply to another AGENT is delivered back
   through the mailbox carrying a hop counter; replies past
   `maxReplyHops` stop instead of ping-ponging forever. Replies to the
   human do not loop (humans don't auto-answer), but they ARE stored, as
   a row addressed to "human", so a reopened chat and the main agent can
   both read what the teammate said.
 */

import type { OutboundEvent } from "../types.ts";
import type { CoworkAgent, CoworkAgentRepo } from "./agent-store.ts";
import type { CoworkMailboxRepo } from "./mailbox.ts";
import type { CoworkHandoffService } from "./handoff.ts";
import { CoworkWorkerLoop } from "./worker-loop.ts";
import type {
  CoworkHandoff,
  CoworkMessage,
} from "./types.ts";

/** The inference seam. Production wires `runUnattended`+`handleTurn`. */
export type CoworkTurnRunner = (
  agent: CoworkAgent,
  prompt: string,
  sessionId: string,
) => Promise<{ text: string; finished: boolean }>;

export interface CoworkRuntimeDeps {
  agents: CoworkAgentRepo;
  mailbox: CoworkMailboxRepo;
  handoffs: CoworkHandoffService;
  runTurn: CoworkTurnRunner;
  emitEvent: (event: OutboundEvent) => void;
  log?: (msg: string) => void;
  tickIntervalMs?: number;
  maxReplyHops?: number;
}

export const DEFAULT_COWORK_TICK_MS = 15_000;
export const DEFAULT_MAX_REPLY_HOPS = 3;

/** The mailbox address of the person. Never a roster id (see cowork-create). */
export const HUMAN = "human";

interface HopPayload {
  coworkHops?: number;
}

/** What a stored answer to the person carries besides the hop count. */
export interface HumanReplyPayload extends HopPayload {
  /** The id of the message this answers. */
  replyTo: string;
  /** Set when the teammate could not answer; the body is then the reason. */
  failed?: boolean;
}

/**
 * Fold each stored answer to the person into the message it answers, and drop
 * the answer's own row. What a reader wants is "question, then its answer";
 * two rows would draw the answer as a second message from nowhere. An answer
 * whose question is not in `rows` stays as its own row rather than vanishing.
 */
export function withHumanReplies(
  rows: CoworkMessage[],
): Array<CoworkMessage & { reply?: string; replyFailed?: boolean }> {
  const answers = new Map<string, { body: string; failed: boolean; rowId: string }>();
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    if (r.toAgentId !== HUMAN || !r.payloadJson) continue;
    try {
      const p = JSON.parse(r.payloadJson) as Partial<HumanReplyPayload>;
      if (typeof p.replyTo === "string" && ids.has(p.replyTo)) {
        answers.set(p.replyTo, { body: r.body, failed: p.failed === true, rowId: r.id });
      }
    } catch {
      /* not one of ours: leave the row as it is */
    }
  }
  const folded = new Set([...answers.values()].map((a) => a.rowId));
  return rows
    .filter((r) => !folded.has(r.id))
    .map((r) => {
      const a = answers.get(r.id);
      return a ? { ...r, reply: a.body, replyFailed: a.failed } : r;
    });
}

function readHops(payloadJson: string | null): number {
  if (!payloadJson) return 0;
  try {
    const parsed = JSON.parse(payloadJson) as HopPayload;
    return typeof parsed.coworkHops === "number" && parsed.coworkHops >= 0
      ? Math.floor(parsed.coworkHops)
      : 0;
  } catch {
    return 0;
  }
}

export class CoworkRuntime {
  readonly #deps: CoworkRuntimeDeps;
  readonly #log: (msg: string) => void;
  readonly #tickIntervalMs: number;
  readonly #maxReplyHops: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Teammates with a drain in progress. Per agent, not one flag for the whole
   * tick: a single flag held every idle teammate's inbox shut until the
   * slowest turn in the roster had finished, so a message to an idle Atlas
   * waited out all of Bolt's ten minutes.
   */
  readonly #busy = new Set<string>();
  /** Teammate id -> the thread of the message or handoff it is working on. */
  readonly #threads = new Map<string, string | null>();
  #running = false;

  constructor(deps: CoworkRuntimeDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? (() => {});
    this.#tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_COWORK_TICK_MS;
    this.#maxReplyHops = deps.maxReplyHops ?? DEFAULT_MAX_REPLY_HOPS;
  }

  /** Idempotent. Self-rescheduling, unref'd — never keeps the process alive. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    // A new message starts a drain at once instead of at the next tick.
    this.#deps.mailbox.onSend = () => this.wake();
    this.#schedule();
  }

  stop(): void {
    this.#running = false;
    this.#deps.mailbox.onSend = null;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Drain now. Teammates already mid-turn are skipped by `tick`, and pick the
   * message up when their drain loops back, so this is safe to call on every
   * send. Before it, a message waited for the next 15 s tick.
   */
  wake(): void {
    if (!this.#running) return;
    void this.tick().catch((err) =>
      this.#log(`cowork: tick failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  #schedule(): void {
    // The timer does not wait for the drain it starts: a teammate's turn can
    // take minutes, and the other teammates' inboxes must not wait with it.
    this.#timer = setTimeout(() => {
      this.wake();
      if (this.#running) this.#schedule();
    }, this.#tickIntervalMs);
    if (typeof this.#timer.unref === "function") this.#timer.unref();
  }

  /** Drain every idle teammate once. A teammate already draining is skipped. */
  async tick(): Promise<void> {
    const roster = this.#deps.agents.list().filter((a) => !this.#busy.has(a.id));
    if (roster.length === 0) return;
    const worker = new CoworkWorkerLoop(
      {
        mailbox: this.#deps.mailbox,
        handoffs: this.#deps.handoffs,
        onMessage: (msg) => this.#onMessage(msg),
        onHandoff: (h) => this.#onHandoff(h),
        // Names, not ids, in everything the person reads. The roster is
        // already loaded above; this is a lookup, not a second query.
        nameOf: (id) => this.#deps.agents.get(id)?.name ?? id,
      },
      this.#deps.emitEvent,
    );
    // Teammates drain CONCURRENTLY. Serially, an agent's inbox could not be
    // touched until every agent before it in the roster had finished a full
    // model turn — so Bolt's reply to Atlas waited out Atlas's entire turn
    // before its own even started. Measured on this box: Atlas ~4 minutes,
    // Bolt 10-15, for the same one-line task. Their turns are independent by
    // construction (separate sessions, separate inboxes); the only thing the
    // serial walk bought was a queue nobody asked for.
    //
    // allSettled, not all: one agent throwing must not cancel the rest, which
    // is what the per-agent catch was already there to guarantee.
    await Promise.allSettled(
      roster.map(async (agent) => {
        this.#busy.add(agent.id);
        try {
          // Loop until the inbox stays empty: a message that arrived while
          // this teammate was mid-turn found it busy and was left for us.
          // Bounded, because a row that somehow never leaves `pending` would
          // otherwise spin here; the next tick picks up whatever is left.
          for (let round = 0; round < 20 && this.#hasWork(agent.id); round++) {
            await worker.tick(agent.id);
          }
        } catch (err) {
          // One broken agent must not starve the rest of the roster.
          this.#log(
            `cowork: agent ${agent.name} tick failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          this.#busy.delete(agent.id);
        }
      }),
    );
  }

  /**
   * The chat a teammate is working for right now, or null. The approval gate
   * uses it so a request lands in the conversation it belongs to.
   */
  threadOf(agentId: string): string | null {
    return this.#threads.get(agentId) ?? null;
  }

  #hasWork(agentId: string): boolean {
    return (
      this.#deps.mailbox.inbox(agentId, "pending").length > 0 ||
      this.#deps.handoffs
        .history(agentId)
        .some((h) => h.toAgentId === agentId && h.status === "initiated")
    );
  }

  async #onMessage(msg: CoworkMessage): Promise<{ ok: boolean; output: string }> {
    const receiver = this.#deps.agents.get(msg.toAgentId);
    if (!receiver) return { ok: false, output: `unknown cowork agent ${msg.toAgentId}` };
    const hops = readHops(msg.payloadJson);
    const prompt = this.#composeMessagePrompt(receiver, msg, hops);
    let turn: { text: string; finished: boolean };
    this.#threads.set(receiver.id, msg.threadId);
    try {
      turn = await this.#deps.runTurn(receiver, prompt, this.sessionIdFor(receiver.id));
    } catch (err) {
      this.#keepForHuman(receiver, msg, hops, err instanceof Error ? err.message : String(err), true);
      throw err;
    } finally {
      this.#threads.delete(receiver.id);
    }
    if (!turn.finished) {
      const reason = "turn ended unfinished (deadline/budget)";
      this.#keepForHuman(receiver, msg, hops, reason, true);
      return { ok: false, output: reason };
    }
    this.#keepForHuman(receiver, msg, hops, turn.text, false);
    await this.#maybeReply(receiver, msg, turn.text, hops);
    return { ok: true, output: turn.text };
  }

  /**
   * Store a teammate's answer to the PERSON. It used to live only in the live
   * event, so a reopened chat showed the question with no answer, and the
   * main agent, which sent it on the person's behalf, could never read it.
   *
   * Addressed to "human", which no teammate drains, so it cannot loop. The
   * hop count is the incoming one, unchanged: the answer is not a new hop,
   * and bumping it would cut the thread's agent-to-agent budget short.
   */
  #keepForHuman(
    receiver: CoworkAgent,
    msg: CoworkMessage,
    hops: number,
    text: string,
    failed: boolean,
  ): void {
    if (msg.fromAgentId !== HUMAN) return;
    const payload: HumanReplyPayload = { coworkHops: hops, replyTo: msg.id, ...(failed ? { failed } : {}) };
    this.#deps.mailbox.send({
      fromAgentId: receiver.id,
      toAgentId: HUMAN,
      threadId: msg.threadId,
      body: text,
      payloadJson: JSON.stringify(payload),
    });
  }

  async #onHandoff(h: CoworkHandoff): Promise<{ ok: boolean; output: string }> {
    const receiver = this.#deps.agents.get(h.toAgentId);
    if (!receiver) return { ok: false, output: `unknown cowork agent ${h.toAgentId}` };
    const artifactLine =
      h.artifactRefs.length > 0
        ? `\nRelevant artifacts: ${h.artifactRefs.join(", ")}`
        : "";
    const prompt =
      `You are "${receiver.name}"${receiver.role ? `, role: ${receiver.role}` : ""}. ` +
      `${receiver.instructions}\n\n` +
      `A teammate (${h.fromAgentId}) handed this task to you. Own it end to end.\n\n` +
      `Task: ${h.summary}${artifactLine}`;
    this.#threads.set(receiver.id, h.threadId);
    let turn: { text: string; finished: boolean };
    try {
      turn = await this.#deps.runTurn(receiver, prompt, this.sessionIdFor(receiver.id));
    } finally {
      this.#threads.delete(receiver.id);
    }
    const { text, finished } = turn;
    if (!finished) {
      throw new Error("handoff turn ended unfinished (deadline/budget)");
    }
    // The outcome flows back to the sender so ownership is visibly returned.
    if (h.fromAgentId !== "human") {
      this.#deps.mailbox.send({
        fromAgentId: h.toAgentId,
        toAgentId: h.fromAgentId,
        threadId: h.threadId,
        body: `[handoff result] ${text}`,
      });
    }
    return { ok: true, output: text };
  }

  async #maybeReply(
    receiver: CoworkAgent,
    msg: CoworkMessage,
    answer: string,
    hops: number,
  ): Promise<void> {
    // The human's answer is stored by #keepForHuman; it never loops back.
    if (msg.fromAgentId === HUMAN) return;
    if (hops >= this.#maxReplyHops) {
      this.#log(
        `cowork: reply dropped at hop limit (${this.#maxReplyHops}) on thread ${msg.threadId ?? "none"}`,
      );
      return;
    }
    this.#deps.mailbox.send({
      fromAgentId: receiver.id,
      toAgentId: msg.fromAgentId,
      threadId: msg.threadId,
      body: answer,
      payloadJson: JSON.stringify({ coworkHops: hops + 1 } satisfies HopPayload),
    });
  }

  #composeMessagePrompt(agent: CoworkAgent, msg: CoworkMessage, hops: number): string {
    const hopNote =
      hops > 0 ? `\n(This thread is ${hops} exchange${hops > 1 ? "s" : ""} deep; wrap up rather than extending it.)` : "";
    return (
      `You are "${agent.name}"${agent.role ? `, role: ${agent.role}` : ""}. ` +
      `${agent.instructions}\n\n` +
      (msg.fromAgentId === "human"
        ? `The user writes:\n`
        : `A teammate (${msg.fromAgentId}) writes:\n`) +
      `${msg.body}${hopNote}`
    );
  }

  sessionIdFor(agentId: string): string {
    return `cowork:${agentId}`;
  }
}
