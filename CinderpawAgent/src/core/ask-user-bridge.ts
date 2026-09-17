/**
 * AskUserBridge — Promise-based interface for asking the user
 * interactive questions.
 *
 * Lives at the agent level (created in index.ts). Threaded into every
 * ToolContext so the `ask_user` tool can call it. The bridge:
 *   - holds a map of pending requests by id
 *   - emits an `ask_user` event for each new request
 *   - resolves the matching Promise when `resolve()` is called
 *   - waits until the person answers or cancels, unless a timeout was set
 *   - supports `cancel()` for session shutdown / navigation
 *
 * The Tauri transport (or any transport) wires `resolve()` to the
 * inbound `ask_user_response` envelope; this module is transport-agnostic
 * — it only knows about OutboundEvent / Promise / timeout.
 */

import { randomUUID } from "node:crypto";
import type {
  AskUserAnswer,
  AskUserBridge,
  AskUserQuestion,
  OutboundEvent,
} from "../types.ts";
import { AskUserTimeoutError } from "../types.ts";

// Re-export for callers that import the bridge + the error from one place.
export { AskUserTimeoutError };

export interface AskUserBridgeConfig {
  /**
   * Per-request timeout in ms, or null to wait for the person. Default null.
   *
   * It was 5 minutes, after which the recommended option was picked on the
   * person's behalf. A question is asked because the answer is theirs to give;
   * picking one because they were reading, or away from the desk, gave them an
   * outcome they never chose. They still end a question by answering it, by
   * dismissing it, or with Stop. Walk-away mode (CINDERPAW_AUTONOMOUS) does not
   * reach this wait at all: it answers routine questions before asking.
   */
  timeoutMs: number | null;
}

const DEFAULT_CONFIG: AskUserBridgeConfig = {
  timeoutMs: null,
};

interface Pending {
  resolve: (answers: AskUserAnswer[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  questions: AskUserQuestion[];
}

/**
 * Sessions the desktop event can't reach (messaging connectors) get their
 * questions asked IN the channel by a delegate. The bridge stays the single
 * entry point — `ask()` consults the delegate first per sessionId.
 */
export interface AskDelegate {
  canHandle(sessionId: string): boolean;
  ask(questions: AskUserQuestion[], sessionId: string): Promise<AskUserAnswer[]>;
}

export class AskUserBridgeImpl implements AskUserBridge {
  readonly #emit: (event: OutboundEvent) => void;
  readonly #config: AskUserBridgeConfig;
  readonly #pending = new Map<string, Pending>();
  #delegate: AskDelegate | null = null;

  constructor(emit: (event: OutboundEvent) => void, config: Partial<AskUserBridgeConfig> = {}) {
    this.#emit = emit;
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Wire the channel delegate (ConnectorManager's ChannelAskRouter). */
  setDelegate(delegate: AskDelegate | null): void {
    this.#delegate = delegate;
  }

  /**
   * Ask the user a question. Emits the `ask_user` event, returns a Promise
   * that resolves on the matching `ask_user_response` (or rejects on
   * timeout / cancel / transport error).
   *
   * `sessionId` is included in the event so the transport can route the
   * response to the right session in the React store.
   */
  ask(questions: AskUserQuestion[], sessionId: string = "default"): Promise<AskUserAnswer[]> {
    // Connector sessions: ask in the channel, not on the desktop.
    if (this.#delegate?.canHandle(sessionId)) {
      return this.#delegate.ask(questions, sessionId);
    }
    const id = randomUUID();
    return new Promise<AskUserAnswer[]>((resolve, reject) => {
      const limit = this.#config.timeoutMs;
      const timer = limit === null ? null : setTimeout(() => {
        const p = this.#pending.get(id);
        if (!p) return;
        this.#pending.delete(id);
        this.#emit({ type: "ask_user_cancelled", id, sessionId, reason: "timeout" });
        reject(new AskUserTimeoutError(id, limit));
      }, limit);

      this.#pending.set(id, { resolve, reject, timer, questions });

      this.#emit({ type: "ask_user", id, sessionId, questions });
    });
  }

  /**
   * Resolve a pending request. Called by the transport when an
   * `ask_user_response` arrives. No-op for unknown ids (the request
   * may have been cancelled or timed out already).
   */
  resolve(id: string, answers: AskUserAnswer[]): void {
    const p = this.#pending.get(id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.#pending.delete(id);
    p.resolve(answers);
  }

  /**
   * Reject a pending request. Called on user-cancel (UI) or shutdown.
   * No-op for unknown ids.
   */
  cancel(id: string, reason: string = "cancelled"): void {
    const p = this.#pending.get(id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    this.#pending.delete(id);
    p.reject(new Error(`ask_user request ${id} cancelled: ${reason}`));
  }

  /**
   * Cancel all pending requests. Used on shutdown so no Promise is left
   * hanging and triggering an unhandledRejection.
   */
  cancelAll(reason: string = "agent shutdown"): void {
    for (const [id] of this.#pending) {
      this.cancel(id, reason);
    }
  }

  /** Diagnostic: number of in-flight requests. */
  get pendingCount(): number {
    return this.#pending.size;
  }
}
