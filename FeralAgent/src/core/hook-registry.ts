/**
 * Hook registry — P0-4.
 *
 * Tiny async event emitter with a "block" semantic for `before_*` events.
 * Pattern from OpenClaw. The registry is a shared singleton owned by
 * the sidecar (constructed in `index.ts`); layers emit events into it
 * via thin calls and the registry invokes every subscribed handler.
 *
 * Design choices:
 *   - Handlers run in registration order. Sequential, not parallel —
 *     ordering matters for the "first blocker wins" semantic and for
 *     deterministic log lines.
 *   - A handler that throws (sync or via a rejected promise) is caught
 *     and logged to stderr. The pipeline must never crash because a
 *     user-supplied hook misbehaved.
 *   - `fire()` returns the FIRST blocking result, or `null` if no
 *     handler blocked. Callers (the tool registry, the agent loop) use
 *     the result to decide whether to proceed.
 *   - The registry is dependency-free — no `EventEmitter` from Node,
 *     no `events` package. The surface is small enough that a hand-
 *     rolled implementation reads better than wrapping a bigger API.
 */

import type {
  HookEvent,
  HookResult,
  Unsubscribe,
} from "../types.ts";

type AnyHandler = (payload: unknown) => Promise<HookResult> | HookResult;

export type HookHandler<E extends HookEvent> = (
  payload: E extends "before_tool_call" ? import("../types.ts").BeforeToolCallPayload :
           E extends "after_tool_call" ? import("../types.ts").AfterToolCallPayload :
           E extends "before_prompt_build" ? import("../types.ts").BeforePromptBuildPayload :
           E extends "before_compaction" ? import("../types.ts").BeforeCompactionPayload :
           E extends "agent_start" ? import("../types.ts").AgentStartPayload :
           E extends "agent_end" ? import("../types.ts").AgentEndPayload :
           E extends "subagent_spawn" ? import("../types.ts").SubagentSpawnPayload :
           E extends "subagent_complete" ? import("../types.ts").SubagentCompletePayload :
           E extends "after_memory_write" ? import("../types.ts").AfterMemoryWritePayload :
           never,
) => Promise<HookResult> | HookResult;

export class HookRegistry {
  /** Event → list of handlers. Insertion order matters (see class doc). */
  readonly #handlers = new Map<HookEvent, AnyHandler[]>();

  /**
   * Register a handler for an event. Returns an unsubscribe function
   * that detaches this exact handler. Calling the unsubscribe twice
   * is a no-op.
   */
  on<E extends HookEvent>(event: E, handler: HookHandler<E>): Unsubscribe {
    let list = this.#handlers.get(event);
    if (!list) {
      list = [];
      this.#handlers.set(event, list);
    }
    list.push(handler as AnyHandler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const cur = this.#handlers.get(event);
      if (!cur) return;
      const idx = cur.indexOf(handler as AnyHandler);
      if (idx >= 0) cur.splice(idx, 1);
      if (cur.length === 0) this.#handlers.delete(event);
    };
  }

  /**
   * Fire an event. Every registered handler is awaited in order. The
   * first handler to return `{ block: true, reason }` short-circuits
   * the rest and that result is returned to the caller. If no handler
   * blocks (or there are no handlers) the call resolves to `null`.
   *
   * Handler errors are caught and logged to stderr; the pipeline keeps
   * going. The promise NEVER rejects.
   */
  async fire<E extends HookEvent>(event: E, payload: unknown): Promise<HookResult | null> {
    const list = this.#handlers.get(event);
    if (!list || list.length === 0) return null;
    for (const handler of list) {
      let result: HookResult;
      try {
        result = await handler(payload);
      } catch (err) {
        // Last-resort visibility. A misbehaving hook must never crash
        // the agent. We log to stderr because the hook system has no
        // dependency on the audit log (the hook might be the audit
        // log's own caller).
        process.stderr.write(
          `[hooks] handler for "${event}" failed: ${String(err)}\n`,
        );
        continue;
      }
      // Normalise "void" (no return) to a non-blocking result.
      const normalised: HookResult = result ?? { block: false };
      if (normalised.block) {
        return normalised;
      }
    }
    return null;
  }

  /**
   * Drop every handler. Used by tests and by hot-reload flows (e.g. on
   * `set_model` we could re-attach plugin-supplied hooks).
   */
  clear(): void {
    this.#handlers.clear();
  }

  /** Read-only inspection — used by the `tool_health` self-diagnosis. */
  countFor(event: HookEvent): number {
    return this.#handlers.get(event)?.length ?? 0;
  }
}
