/**
 * Cowork worker loop (S3) — the reactive engine per agent.
 *
 * One `tick(agentId)` drains everything addressed to that agent:
 * pending mailbox messages and handoffs initiated toward it. Every step
 * emits a `cowork_event` through the injected `emitEvent` callback so the
 * A2A conversation is visible in the user's chat surface (the locked
 * design rule — never log-only).
 *
 * Ownership discipline: a handoff is ACCEPTED (claimed) before processing
 * begins and driven to completed|failed after — never left `initiated`,
 * which per protocol means "task not done".
 *
 * The inference seam is injected, not imported: `onMessage` / `onHandoff`
 * turn one item into an outcome. Wiring the real AgentLoop behind them
 * (Brain routing per agent, tool scoping) is the S3.5 boot-integration
 * step; this module stays pure and fully testable without it. v1 is
 * strictly reactive: nothing here wakes up on its own.
 */

import type { OutboundEvent } from "../types.ts";
import type { CoworkMailboxRepo } from "./mailbox.ts";
import type { CoworkHandoffService } from "./handoff.ts";
import type { CoworkMessage, CoworkHandoff } from "./types.ts";

export interface CoworkTurnOutcome {
  ok: boolean;
  /** The result summary / rejection reason, recorded for audit. */
  output: string;
}

export interface CoworkWorkerDeps {
  mailbox: CoworkMailboxRepo;
  handoffs: CoworkHandoffService;
  /**
   * Turn one incoming message into an outcome. Throw or return
   * `{ ok: false }` to reject — both paths mark the message rejected.
   */
  onMessage: (msg: CoworkMessage) => Promise<CoworkTurnOutcome>;
  /**
   * Execute one claimed handoff. Throw or return `{ ok: false }` to fail
   * the handoff with `output` as the reason.
   */
  onHandoff: (handoff: CoworkHandoff) => Promise<CoworkTurnOutcome>;
}

export interface CoworkTickResult {
  processedMessages: number;
  handledHandoffs: number;
}

export class CoworkWorkerLoop {
  readonly #deps: CoworkWorkerDeps;
  readonly #emitEvent: (event: OutboundEvent) => void;

  constructor(deps: CoworkWorkerDeps, emitEvent: (event: OutboundEvent) => void) {
    this.#deps = deps;
    this.#emitEvent = emitEvent;
  }

  /** Drain everything addressed to `agentId`. Idempotent between inbox changes. */
  async tick(agentId: string): Promise<CoworkTickResult> {
    const messages = await this.#drainMessages(agentId);
    const handoffs = await this.#claimAndRunHandoffs(agentId);
    return { processedMessages: messages, handledHandoffs: handoffs };
  }

  async #drainMessages(agentId: string): Promise<number> {
    const pending = this.#deps.mailbox.inbox(agentId, "pending");
    let processed = 0;
    for (const msg of pending) {
      const title =
        msg.fromAgentId === "human"
          ? `Human → ${agentId}`
          : `${msg.fromAgentId} → ${agentId}`;
      this.#emit(msg, agentId, "message_received", title, {
        messageId: msg.id,
        fromAgentId: msg.fromAgentId,
        body: msg.body,
      });
      try {
        const outcome = await this.#deps.onMessage(msg);
        if (!outcome.ok) throw new Error(outcome.output);
        this.#deps.mailbox.updateStatus(msg.id, "processed");
        this.#emit(msg, agentId, "message_processed", title, {
          messageId: msg.id,
          output: outcome.output,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.#deps.mailbox.updateStatus(msg.id, "rejected");
        this.#emit(msg, agentId, "message_rejected", title, {
          messageId: msg.id,
          reason,
        });
        continue;
      }
      processed++;
    }
    return processed;
  }

  async #claimAndRunHandoffs(agentId: string): Promise<number> {
    // history() covers both directions; we only act on ownership offers.
    const open = this.#deps.handoffs
      .history(agentId)
      .filter((h) => h.toAgentId === agentId && h.status === "initiated");
    let handled = 0;
    for (const offer of open) {
      const title = `${offer.fromAgentId} ⇢ ${agentId}: ${offer.summary}`;
      this.#emit(offer, agentId, "handoff_received", title, {
        handoffId: offer.id,
        fromAgentId: offer.fromAgentId,
        summary: offer.summary,
      });
      // Claim BEFORE running — the audit record must show an owner even if
      // the very next line throws.
      this.#deps.handoffs.accept(offer.id);
      try {
        const outcome = await this.#deps.onHandoff(offer);
        if (!outcome.ok) throw new Error(outcome.output);
        this.#deps.handoffs.complete(offer.id, outcome.output);
        this.#emit(offer, agentId, "handoff_completed", title, {
          handoffId: offer.id,
          result: outcome.output,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.#deps.handoffs.fail(offer.id, reason);
        this.#emit(offer, agentId, "handoff_failed", title, {
          handoffId: offer.id,
          reason,
        });
        continue;
      }
      handled++;
    }
    return handled;
  }

  #emit(
    item: CoworkMessage | CoworkHandoff,
    agentId: string,
    eventType: Extract<
      OutboundEvent,
      { type: "cowork_event" }
    >["eventType"],
    title: string,
    data: Record<string, unknown>,
  ): void {
    this.#emitEvent({
      type: "cowork_event",
      eventType,
      agentId,
      threadId: item.threadId ?? undefined,
      title,
      data,
    });
  }
}
