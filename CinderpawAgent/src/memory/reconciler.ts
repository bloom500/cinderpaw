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
   * branch; Task 4 additionally calls `graph.reconcile(treeView)` on
   * the observation branch so fact ↔ graph can't drift. Always
   * resolves to `{ block: false }` because `after_memory_write` is
   * informational, not gateable.
   */
  async #handle(payload: AfterMemoryWritePayload): Promise<{ block: false }> {
    if (payload.kind === "fact") {
      await this.#handleFact(payload);
    } else {
      await this.#handleObservation(payload);
    }
    return { block: false };
  }

  /**
   * Observation branch — mirror the current tree view into the
   * knowledge graph so graph nodes match the fractal tree after every
   * observation write. Idempotent (graph.upsertNode collapses on id).
   *
   * The fractal tree itself doesn't change here (observations live in
   * EpisodicMemory and are picked up by the next tree rebuild). Only
   * the graph mirror moves on each observation.
   */
  async #handleObservation(payload: AfterMemoryWritePayload): Promise<void> {
    if (payload.kind !== "observation") return;
    try {
      const view = this.#deps.fractal.treeView();
      this.#deps.graph.reconcile(view);
    } catch (e) {
      // Reconcile failure is non-fatal — the next observation write
      // will retry. Logging at debug keeps stdout clean in normal flow.
      console.debug(
        `[reconciler] graph.reconcile threw for "${payload.title ?? "(untitled)"}": ${String(e)}`,
      );
    }
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
      // never crash because the embedding model is unavailable. But it
      // must not degrade SILENTLY either: this exact quiet path is how a
      // box can go days without a single new leaf while conversations
      // keep happening (2026-08-20..24, found via file mtimes). A warn
      // on stderr is the operator's only signal.
      console.warn(
        `[reconciler] leaf NOT saved — embed() threw for "${text.slice(0, 80)}": ${String(e)}`,
      );
      return;
    }
    const vec = embedding[0];
    if (!vec || vec.length === 0) {
      console.warn(
        `[reconciler] leaf NOT saved — embedder returned no vector for "${text.slice(0, 80)}" ` +
          `(embedding model missing or failed to load); fact stays in SemanticMemory (FTS5 path)`,
      );
      return;
    }

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
