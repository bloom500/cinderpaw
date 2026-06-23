/**
 * Reconciler — Pathway 3 step 2 Task 2.
 *
 * The single subscriber to `after_memory_write`. Owns the response to a
 * capture event: route the payload into the FractalMemory tree (Task 3)
 * and mirror the result into the MemoryGraph (Task 4). Task 2 ships
 * only the subscription scaffolding; the handler body is a no-op log
 * until Task 3 wires the actual upsert.
 *
 * Lifecycle:
 *   - construct with `{ hooks, fractal, graph }`
 *   - call `start()` once at sidecar boot (idempotent)
 *   - call `stop()` on teardown / hot-reload (idempotent)
 *
 * Design choices:
 *   - `start()` is idempotent so accidental double-construction in tests
 *     or hot-reload paths can't double-subscribe (each `fire` would then
 *     reach the handler twice).
 *   - `stop()` is a no-op before `start()` so partial-init code paths
 *     don't crash on cleanup.
 *   - Handler errors are caught by the registry contract; the
 *     Reconciler never throws to its caller.
 */

import type { HookRegistry } from "../core/hook-registry.ts";
import type { Unsubscribe, AfterMemoryWritePayload } from "../types.ts";
import type { FractalMemory } from "./fractal/fractal-memory.ts";
import type { MemoryGraph } from "./graph.ts";

export interface ReconcilerDeps {
  hooks: HookRegistry;
  /** Tree to upsert into. Task 3 will call `fractal.upsertLeaf(...)`. */
  fractal: FractalMemory;
  /** Graph to mirror. Task 4 will call `graph.reconcile(treeView)`. */
  graph: MemoryGraph;
}

export class Reconciler {
  readonly #deps: ReconcilerDeps;
  #unsubscribe: Unsubscribe | null = null;

  constructor(deps: ReconcilerDeps) {
    this.#deps = deps;
  }

  /**
   * Subscribe to `after_memory_write`. Idempotent — calling twice does
   * not double-subscribe. A no-op when already started.
   */
  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#deps.hooks.on(
      "after_memory_write",
      (payload) => this.#handle(payload),
    );
  }

  /**
   * Unsubscribe. Idempotent — calling twice or before `start()` is
   * safe. Never throws.
   */
  stop(): void {
    if (!this.#unsubscribe) return;
    this.#unsubscribe();
    this.#unsubscribe = null;
  }

  /**
   * Handler body — Task 2 ships a debug-log no-op. Task 3 will route
   * the payload into `fractal.upsertLeaf(...)`; Task 4 will additionally
   * call `graph.reconcile(treeView)` for observation writes.
   *
   * Returning a Promise<HookResult> is the registry contract; we always
   * resolve to `{ block: false }` because `after_memory_write` is an
   * informational event, not a gateable one.
   */
  async #handle(payload: AfterMemoryWritePayload): Promise<{ block: false }> {
    // Keep the log tight and grep-able — Task 3 will swap this for the
    // real wiring. `console.debug` (not console.log) so it stays out
    // of stdout unless FERAL_DEBUG=1 / verbose mode is on.
    console.debug(
      `[reconciler] ${payload.kind}` +
        (payload.kind === "fact"
          ? ` ${payload.key}=${payload.value}`
          : ` ${payload.obsType}:${payload.title}`),
    );
    return { block: false };
  }
}
