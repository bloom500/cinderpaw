/**
 * Reconciler — Pathway 3 step 2 Task 2 + Task 3 wiring.
 *
 * The single subscriber to `after_memory_write`. Owns the response to a
 * capture event: route a fact into the FractalMemory tree
 * (`fractal.upsertLeaf(...)`). Observations need nothing here: they live
 * in EpisodicMemory and reach the tree at the next rebuild.
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

import { memoryScope } from "./semantic.ts";
import type { HookRegistry } from "../core/hook-registry.ts";
import type { Unsubscribe, AfterMemoryWritePayload } from "../types.ts";
import type { FractalMemory } from "./fractal/fractal-memory.ts";
import type { MemoryGraph } from "./graph.ts";
import type { EmbedInvoker } from "./fractal/embed.ts";

export interface ReconcilerDeps {
  hooks: HookRegistry;
  /** Tree to upsert into. Wired in Task 3: `fractal.upsertLeaf(...)`. */
  fractal: FractalMemory;
  // ponytail: unread since the tree stopped being mirrored into the graph;
  // kept so the five constructors still compile. Drop with their next edit.
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
   * Handler body. Only a fact moves anything. Always resolves to
   * `{ block: false }` because `after_memory_write` is informational,
   * not gateable.
   *
   * An observation used to mirror the whole tree into the graph: every
   * episodic row read back from SQLite, then one edgeless node per row.
   * Recall reads only edges, and the Memory page lists edgeless nodes,
   * so each conversation fragment would have shown there as a "memory".
   */
  async #handle(payload: AfterMemoryWritePayload): Promise<{ block: false }> {
    if (payload.kind === "fact") await this.#handleFact(payload);
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
    // A guest speaker's fact is scoped to them in SemanticMemory and reaches
    // them through the known-facts block. The tree is shared by every session's
    // recall, so a leaf here would hand it to the owner and every other member
    // of the room — the leak `memoryScope` exists to close.
    if (memoryScope(payload.sessionId) !== "") return;

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
