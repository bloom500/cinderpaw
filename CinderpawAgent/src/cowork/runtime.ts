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
   human do not loop (humans don't auto-answer).
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

interface HopPayload {
  coworkHops?: number;
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
  #inflight = false;
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
    this.#schedule();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #schedule(): void {
    this.#timer = setTimeout(() => {
      void this.tick()
        .catch((err) => {
          // One bad tick must never kill the loop (heartbeat rule).
          this.#log(
            `cowork: tick failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          if (this.#running) this.#schedule();
        });
    }, this.#tickIntervalMs);
    if (typeof this.#timer.unref === "function") this.#timer.unref();
  }

  /** Drain every configured agent once. Safe to call concurrently-guarded. */
  async tick(): Promise<void> {
    if (this.#inflight) return;
    this.#inflight = true;
    try {
      const roster = this.#deps.agents.list();
      if (roster.length === 0) return;
      const worker = new CoworkWorkerLoop(
        {
          mailbox: this.#deps.mailbox,
          handoffs: this.#deps.handoffs,
          onMessage: (msg) => this.#onMessage(msg),
          onHandoff: (h) => this.#onHandoff(h),
        },
        this.#deps.emitEvent,
      );
      for (const agent of roster) {
        try {
          await worker.tick(agent.id);
        } catch (err) {
          // One broken agent must not starve the rest of the roster.
          this.#log(
            `cowork: agent ${agent.name} tick failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      this.#inflight = false;
    }
  }

  async #onMessage(msg: CoworkMessage): Promise<{ ok: boolean; output: string }> {
    const receiver = this.#deps.agents.get(msg.toAgentId);
    if (!receiver) return { ok: false, output: `unknown cowork agent ${msg.toAgentId}` };
    const hops = readHops(msg.payloadJson);
    const prompt = this.#composeMessagePrompt(receiver, msg, hops);
    const { text, finished } = await this.#deps.runTurn(
      receiver,
      prompt,
      this.sessionIdFor(receiver.id),
    );
    if (!finished) {
      return { ok: false, output: "turn ended unfinished (deadline/budget)" };
    }
    await this.#maybeReply(receiver, msg, text, hops);
    return { ok: true, output: text };
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
    const { text, finished } = await this.#deps.runTurn(
      receiver,
      prompt,
      this.sessionIdFor(receiver.id),
    );
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
    // The human gets their answer through the rendered event, not a
    // self-addressed mailbox loop.
    if (msg.fromAgentId === "human") return;
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
