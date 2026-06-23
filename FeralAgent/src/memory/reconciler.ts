/**
 * Reconciler — Pathway 3 step 2 Task 2 + Task 3 wiring.
 *
 * The single subscriber to `after_memory_write`. Owns the response to a
 * capture event: route the payload into the FractalMemory tree (Task 3)
 * and mirror the result into the MemoryGraph (Task 4). Task 3 wired
 * `fractal.upsertLeaf(...)` for fact writes; Task 4 will additionally
 * call `graph.reconcile(treeView)` for observation writes.
 *
 * Lifecycle:
 *   - construct with `{ hooks, fractal, graph, embed }`
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
 *   - Empty embedding (model missing) degrades to a no-op — the
 *     capture pipeline never crashes because the embedder is missing.
 */

import type { HookRegistry } from "../core/hook-registry.ts";
import type { Unsubscribe, AfterMemoryWritePayload } from "../types.ts";
import type { FractalMemory } from "./fractal/fractal-memory.ts";
import type { MemoryGraph } from "./graph.ts";
import type { EmbedInvoker } from "./fractal/embed.ts";

export interface ReconcilerDeps {
  hooks: HookRegistry;
  /** Tree to upsert into. Wired in Task 3: `fractal.upsertLeaf(...)`. */
  fractal: FractalMemory;
  /** Graph to mirror. Wired in Task 4: `graph.reconcile(treeView)`. */
  graph: MemoryGraph;
  /** Embedder — same one the sidecar uses for query/leaf text. */
  embed: EmbedInvoker;
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
    const handler = (payload: AfterMemoryWritePayload): Promise<{ block: false }> =>
      this.#handle(payload);
    this.#unsubscribe = this.#deps.hooks.on("after_memory_write", handler);
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
   * Handler body — Task 3 wires `fractal.upsertLeaf(...)` on the fact
   * branch; Task 4 will additionally call `graph.reconcile(treeView)`
   * for observation writes. Always resolves to `{ block: false }`
   * because `after_memory_write` is informational, not gateable.
   */
  async #handle(payload: AfterMemoryWritePayload): Promise<{ block: false }> {
    if (payload.kind === "fact") {
      await this.#handleFact(payload);
    } else {
      // Observation — Task 4 wires `graph.reconcile(treeView)` here.
      // Until then, this is a debug-log no-op (same shape as Task 2).
      console.debug(
        `[reconciler] observation ${payload.obsType}:${payload.title}`,
      );
    }
    return { block: false };
  }

  /**
   * Fact branch — compute the embedding, then upsert into the tree.
   * Graceful no-op when the embedder returns an empty vector (model
   * missing on disk); the fact stays in SemanticMemory and the agent
   * loop keeps surfacing it via the FTS5 path.
   */
  async #handleFact(payload: AfterMemoryWritePayload): Promise<void> {
    // Defensive: caller should only invoke with kind="fact", but the
    // narrowing happens inside the original #handle dispatcher. Guard
    // here too so the function is safe to call from tests.
    if (payload.kind !== "fact") return;
    const key = payload.key;
    const value = payload.value;
    if (key === undefined || value === undefined) return;

    const text = `${key}: ${value}`;
    let embedding: Float32Array[] = [];
    try {
      embedding = await this.#deps.embed([text]);
    } catch (e) {
      // Embedder threw — degrade to no-op. The capture pipeline must
      // never crash because the embedding model is unavailable.
      console.debug(`[reconciler] embed() threw for "${text}": ${String(e)}`);
      return;
    }
    const vec = embedding[0];
    if (!vec || vec.length === 0) return; // model missing

    await this.#deps.fractal.upsertLeaf({
      text,
      embedding: Array.from(vec),
      provenance: {
        source: "reactive-engine",
        first_seen_at: payload.ts,
        sessionId: payload.sessionId,
        ts: payload.ts,
        key,
        value,
      },
    });
  }
}
