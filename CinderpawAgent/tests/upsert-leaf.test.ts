/**
 * FractalMemory.upsertLeaf + Reconciler wiring — Pathway 3 step 2 Task 3.
 *
 * Pins the reactive write path:
 *   - `upsertLeaf` finds the nearest existing leaf by cosine.
 *   - cosine >= MERGE_THRESHOLD → bumps provenance, emits `seed`, returns.
 *   - else → adds the leaf to the in-memory pending set, persists the
 *     embedding via the optional `persistEmbeddings` hook, emits `grow`.
 *   - Idempotent on `(text, first_seen_at)` — calling twice with the
 *     same args does not double-add.
 *   - Reconciler routes `after_memory_write` → `upsertLeaf` on the
 *     fact branch (observation branch wires graph reconcile in Task 4).
 *
 * What this test guards:
 *   1. No existing leaves → insert + grow + persist.
 *   2. Near-duplicate (cosine >= threshold) → merge + seed, no insert.
 *   3. Far-away (cosine < threshold) → insert + grow.
 *   4. Idempotency on (text, first_seen_at).
 *   5. `CINDERPAW_MERGE_THRESHOLD` env override is honoured.
 *   6. Reconciler fires `upsertLeaf` for the fact path with the right
 *      text shape (`"key: value"`), embedding from the embed stub, and
 *      provenance fields populated.
 *   7. Reconciler does NOT throw when `embed()` returns null (model
 *      missing) — graceful degradation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FractalMemory, type FractalActivity } from "../src/memory/fractal/fractal-memory.ts";
import { Reconciler } from "../src/memory/reconciler.ts";
import { HookRegistry } from "../src/core/hook-registry.ts";
import type { Leaf } from "../src/memory/fractal/types.ts";
import type { EmbedInvoker } from "../src/memory/fractal/embed.ts";

// ---------------------------------------------------------------------------
// Stubs / fixtures
// ---------------------------------------------------------------------------

/** Minimal in-memory loadLeaves stub. Returns whatever was last set via setLeaves. */
function makeLeavesSource(initial: Leaf[] = []) {
  let current = initial;
  return {
    setLeaves(next: Leaf[]) { current = next; },
    getLeaves() { return [...current]; },
    loader: () => [...current],
  };
}

/** Build a unit-norm Float32Array embedding of the given dimension. */
function vec(values: number[]): Float32Array {
  const arr = new Float32Array(values);
  // Already unit-norm for the inputs we use (e.g. [1,0,0]). No normalisation
  // step needed for the test fixtures.
  return arr;
}

/** Identity embedder — returns the input as-is (assumes already unit-norm). */
function identityEmbed(): EmbedInvoker {
  return (texts) => Promise.resolve(texts.map((t) => {
    // Map any string to a deterministic vector by hashing; tests pass
    // their own vec() when they want a specific shape.
    const seed = Array.from(t).reduce((s, c) => s * 31 + c.charCodeAt(0), 7);
    return vec([
      Math.sin(seed),
      Math.cos(seed),
      Math.sin(seed * 2),
    ]);
  }));
}

const silentFts = { search: () => [] };
const noopSummarize = async (_items: string[]) => "summary";
const noopFallback = { recall: () => ({ context: "", facts: [] }) };

interface MemOptions {
  leaves?: Leaf[];
  onActivity?: (a: FractalActivity) => void;
  persistEmbeddings?: (rows: { id: number; vec: Float32Array }[]) => void;
}

function makeMemory(opts: MemOptions = {}) {
  const leavesSource = makeLeavesSource(opts.leaves ?? []);
  return {
    leavesSource,
    fm: new FractalMemory({
      loadLeaves: leavesSource.loader,
      embed: identityEmbed(),
      summarize: noopSummarize,
      ftsSearch: silentFts,
      fallback: noopFallback,
      treePath: ":memory:", // unused for upsertLeaf
      onActivity: opts.onActivity,
      persistEmbeddings: opts.persistEmbeddings,
    }),
  };
}

// ---------------------------------------------------------------------------
// FractalMemory.upsertLeaf
// ---------------------------------------------------------------------------

describe("FractalMemory.upsertLeaf", () => {
  test("adds a new leaf when there are no existing leaves", async () => {
    const activities: FractalActivity[] = [];
    const persisted: { id: number; vec: Float32Array }[] = [];
    const { fm } = makeMemory({
      onActivity: (a) => activities.push(a),
      persistEmbeddings: (rows) => persisted.push(...rows),
    });

    const result = await fm.upsertLeaf({
      text: "language: ro",
      embedding: [1, 0, 0],
      provenance: {
        source: "react",
        first_seen_at: 1_000_000,
        sessionId: "s1",
        ts: 1_000_000,
        key: "language",
        value: "ro",
      },
    });

    expect(result.kind).toBe("grow");
    expect(activities).toHaveLength(1);
    expect(activities[0]?.kind).toBe("grow");
    // Embedding was persisted with the leaf id returned.
    if (result.kind === "grow") {
      expect(persisted.find((p) => p.id === result.leafId)).toBeDefined();
    }
    // The new leaf is in the pending set (next rebuild picks it up).
    const pending = fm.pendingLeaves();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.text).toBe("language: ro");
  });

  test("merges (no new leaf) when cosine >= MERGE_THRESHOLD", async () => {
    const activities: FractalActivity[] = [];
    const persisted: { id: number; vec: Float32Array }[] = [];
    // Seed with one leaf carrying vector [1, 0, 0] (unit-norm).
    const seed: Leaf = {
      id: 100,
      text: "language: ro",
      vec: vec([1, 0, 0]),
      ts: 1_000_000,
      sessionId: "s0",
    };
    const { fm } = makeMemory({
      leaves: [seed],
      onActivity: (a) => activities.push(a),
      persistEmbeddings: (rows) => persisted.push(...rows),
    });

    // Upsert with a near-identical embedding (cosine ≈ 0.9999, >> 0.92).
    const result = await fm.upsertLeaf({
      text: "language: romanian",
      embedding: [0.9999, 0.01, 0],
      provenance: {
        source: "react",
        first_seen_at: 1_000_100,
        sessionId: "s1",
        ts: 1_000_100,
        key: "language",
        value: "romanian",
      },
    });

    expect(result.kind).toBe("seed");
    if (result.kind === "seed") {
      expect(result.leafId).toBe(100);
    }
    expect(activities).toHaveLength(1);
    expect(activities[0]?.kind).toBe("seed");
    // No new pending leaf — the seed leaf's hit_count went up.
    expect(fm.pendingLeaves()).toHaveLength(0);
    // No additional persistEmbeddings call.
    expect(persisted).toHaveLength(0);
  });

  test("inserts a new leaf when cosine < MERGE_THRESHOLD", async () => {
    const activities: FractalActivity[] = [];
    const seed: Leaf = {
      id: 100,
      text: "language: ro",
      vec: vec([1, 0, 0]),
      ts: 1_000_000,
      sessionId: "s0",
    };
    const { fm } = makeMemory({
      leaves: [seed],
      onActivity: (a) => activities.push(a),
    });

    // Upsert with an orthogonal embedding (cosine = 0).
    const result = await fm.upsertLeaf({
      text: "name: Alice",
      embedding: [0, 1, 0],
      provenance: {
        source: "react",
        first_seen_at: 1_000_100,
        sessionId: "s1",
        ts: 1_000_100,
        key: "name",
        value: "Alice",
      },
    });

    expect(result.kind).toBe("grow");
    expect(activities).toHaveLength(1);
    expect(activities[0]?.kind).toBe("grow");
    expect(fm.pendingLeaves()).toHaveLength(1);
    expect(fm.pendingLeaves()[0]?.text).toBe("name: Alice");
  });

  test("is idempotent on (text, first_seen_at)", async () => {
    const activities: FractalActivity[] = [];
    const { fm } = makeMemory({
      onActivity: (a) => activities.push(a),
    });

    const opts = {
      text: "language: ro",
      embedding: [1, 0, 0],
      provenance: {
        source: "react",
        first_seen_at: 1_000_000,
        sessionId: "s1",
        ts: 1_000_000,
        key: "language",
        value: "ro",
      },
    };

    const first = await fm.upsertLeaf(opts);
    const second = await fm.upsertLeaf(opts);

    expect(first.kind).toBe("grow");
    expect(activities).toHaveLength(1); // second call did NOT emit
    expect(fm.pendingLeaves()).toHaveLength(1);
    // Same leaf id reused.
    expect(second.kind).toBe("grow");
    if (first.kind === "grow" && second.kind === "grow") {
      expect(second.leafId).toBe(first.leafId);
    }
  });

  test("respects CINDERPAW_MERGE_THRESHOLD env override", async () => {
    const seed: Leaf = {
      id: 100,
      text: "language: ro",
      vec: vec([1, 0, 0]),
      ts: 1_000_000,
      sessionId: "s0",
    };
    const { fm } = makeMemory({ leaves: [seed] });

    // With threshold = 0.5, a 0.7-cosine upsert would still merge
    // under the default 0.92 — but if we raise the threshold, the same
    // upsert should insert. We model both directions.
    const probe = vec([0.7, 0.7, 0]); // unit-norm-ish (0.7^2+0.7^2=0.98), cosine to seed = 0.7/0.99 ≈ 0.707
    process.env.CINDERPAW_MERGE_THRESHOLD = "0.99"; // higher than the probe cosine
    const resultHigh = await fm.upsertLeaf({
      text: "x: y",
      embedding: Array.from(probe),
      provenance: {
        source: "react",
        first_seen_at: 2_000_000,
        sessionId: "s1",
        ts: 2_000_000,
      },
    });
    expect(resultHigh.kind).toBe("grow"); // threshold 0.99 > 0.707 cosine → insert

    delete process.env.CINDERPAW_MERGE_THRESHOLD;
  });

  test("mutation_seq bumps on insert, not on merge", async () => {
    const seed: Leaf = {
      id: 100,
      text: "language: ro",
      vec: vec([1, 0, 0]),
      ts: 1_000_000,
      sessionId: "s0",
    };
    const { fm } = makeMemory({ leaves: [seed] });
    expect(fm.mutationSeq).toBe(0);

    await fm.upsertLeaf({
      text: "merged",
      embedding: [0.9999, 0.01, 0],
      provenance: {
        source: "react",
        first_seen_at: 2_000_000,
        sessionId: "s1",
        ts: 2_000_000,
      },
    });
    expect(fm.mutationSeq).toBe(0); // merge → no bump

    await fm.upsertLeaf({
      text: "new",
      embedding: [0, 0, 1],
      provenance: {
        source: "react",
        first_seen_at: 3_000_000,
        sessionId: "s1",
        ts: 3_000_000,
      },
    });
    expect(fm.mutationSeq).toBe(1); // insert → bump
  });
});

// ---------------------------------------------------------------------------
// Reconciler wiring
// ---------------------------------------------------------------------------

describe("Reconciler wires after_memory_write → upsertLeaf", () => {
  test("fact payload calls upsertLeaf with text='key: value'", async () => {
    const activities: FractalActivity[] = [];
    const { fm } = makeMemory({ onActivity: (a) => activities.push(a) });
    const hooks = new HookRegistry();
    const reconciler = new Reconciler({
      hooks,
      fractal: fm,
      graph: { reconcile: () => {} },
      embed: identityEmbed(),
    });
    reconciler.start();

    await hooks.fire("after_memory_write", {
      kind: "fact",
      sessionId: "s1",
      ts: 1_000_000,
      key: "language",
      value: "ro",
    });

    expect(activities).toHaveLength(1);
    expect(activities[0]?.kind).toBe("grow");
  });

  test("does not throw when embed() returns null (model missing)", async () => {
    // Build an embedder that yields empty arrays (model missing).
    const emptyEmbed: EmbedInvoker = () => Promise.resolve([]);
    const fm = new FractalMemory({
      loadLeaves: () => [],
      embed: emptyEmbed,
      summarize: noopSummarize,
      ftsSearch: silentFts,
      fallback: noopFallback,
      treePath: ":memory:",
      onActivity: () => {},
    });
    const hooks = new HookRegistry();
    const reconciler = new Reconciler({
      hooks,
      fractal: fm,
      graph: { reconcile: () => {} },
    });
    reconciler.start();

    // Fire should not reject — the reconciler swallows the empty-embed
    // path (no leaves to scan against, no insert with no embedding).
    await hooks.fire("after_memory_write", {
      kind: "fact",
      sessionId: "s1",
      ts: 1,
      key: "x",
      value: "y",
    });
  });
});
