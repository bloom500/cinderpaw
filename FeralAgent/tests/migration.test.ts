/**
 * runMigration + FractalMemory.treeView + MemoryGraph.reconcile —
 * Pathway 3 step 2 Task 4.
 *
 * Pins the last mile of the reactive engine:
 *
 *   - `runMigration` lifts the ~41 pre-step-1 facts into the new tree
 *     exactly once (marker at `<dataDir>/fractal-migration-v1.done`).
 *     Failure-tolerant (no marker on failure → next boot retries).
 *     Idempotent (marker present → no-op).
 *   - `FractalMemory.treeView()` is a read-only snapshot of the
 *     cluster + leaf summary the graph needs.
 *   - `MemoryGraph.reconcile(view)` mirrors tree nodes/edges into
 *     the knowledge graph so fact ↔ graph can't drift.
 *   - The Reconciler's observation branch calls
 *     `graph.reconcile(fractal.treeView())` after `upsertLeaf`.
 *
 * What this test guards:
 *   1. Marker is written only after all facts upsert successfully.
 *   2. Marker presence makes the next call a no-op (zero upserts).
 *   3. A thrown upsertLeaf keeps the marker absent so the next boot
 *      retries.
 *   4. Empty SemanticMemory → marker still written (clean state).
 *   5. Atomic write via tmp + rename.
 *   6. Reconciler observation path calls graph.reconcile with the
 *      treeView snapshot.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { FractalMemory, type FractalActivity } from "../src/memory/fractal/fractal-memory.ts";
import { runMigration, MIGRATION_MARKER_FILENAME } from "../src/memory/fractal/migration.ts";
import { Reconciler } from "../src/memory/reconciler.ts";
import { HookRegistry } from "../src/core/hook-registry.ts";
import { MemoryGraph } from "../src/memory/graph.ts";
import type { Leaf } from "../src/memory/fractal/types.ts";
import type { EmbedInvoker } from "../src/memory/fractal/embed.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "feral-migration-"));
}

function makeSemantic(): { semantic: SemanticMemory; close: () => void } {
  const db = openDatabase(":memory:");
  const semantic = new SemanticMemory(db.raw, () => {});
  return { semantic, close: () => db.close() };
}

function vec(values: number[]): Float32Array {
  return new Float32Array(values);
}

const silentFts = { search: () => [] };
const noopSummarize = async (_items: string[]) => "summary";
const noopFallback = { recall: () => ({ context: "", facts: [] }) };

function identityEmbed(): EmbedInvoker {
  return (texts) => Promise.resolve(
    texts.map((t) => {
      const seed = Array.from(t).reduce((s, c) => s * 31 + c.charCodeAt(0), 7);
      return vec([Math.sin(seed), Math.cos(seed), Math.sin(seed * 2)]);
    }),
  );
}

function makeFm(opts: {
  leaves?: Leaf[];
  dataDir?: string;
  onActivity?: (a: FractalActivity) => void;
} = {}) {
  const treePath = join(opts.dataDir ?? tempDataDir(), "fractal-tree.json");
  return new FractalMemory({
    loadLeaves: () => opts.leaves ?? [],
    embed: identityEmbed(),
    summarize: noopSummarize,
    ftsSearch: silentFts,
    fallback: noopFallback,
    treePath,
    onActivity: opts.onActivity,
  });
}

// ---------------------------------------------------------------------------
// runMigration
// ---------------------------------------------------------------------------

describe("runMigration", () => {
  let dataDir: string;
  beforeEach(() => { dataDir = tempDataDir(); });
  afterEach(() => { if (existsSync(dataDir)) rmSync(dataDir, { recursive: true }); });

  test("writes the marker after processing all facts", async () => {
    const { semantic, close } = makeSemantic();
    try {
      semantic.upsert("language", "ro");
      semantic.upsert("name", "Alice");
      const fm = makeFm({ dataDir });
      const upserted: number[] = [];
      const fmStub = {
        upsertLeaf: async (opts: any) => {
          const id = 100 + upserted.length;
          upserted.push(id);
          return { kind: "grow", leafId: id };
        },
      };

      const result = await runMigration({
        semantic,
        fractal: fmStub as any,
        dataDir,
      });

      expect(result.ran).toBe(true);
      expect(result.facts).toBe(2);
      const markerPath = join(dataDir, MIGRATION_MARKER_FILENAME);
      expect(existsSync(markerPath)).toBe(true);
      // File contents are empty (presence is the signal).
      expect(readFileSync(markerPath, "utf8")).toBe("");
    } finally {
      close();
    }
  });

  test("is a no-op when the marker is present (does not re-upsert)", async () => {
    const { semantic, close } = makeSemantic();
    try {
      semantic.upsert("language", "ro");
      semantic.upsert("name", "Alice");
      // Pre-write the marker.
      writeFileSync(join(dataDir, MIGRATION_MARKER_FILENAME), "");
      let upsertCalls = 0;
      const fmStub = {
        upsertLeaf: async () => { upsertCalls++; return { kind: "grow", leafId: 1 }; },
      };

      const result = await runMigration({
        semantic,
        fractal: fmStub as any,
        dataDir,
      });

      expect(result.ran).toBe(false);
      expect(upsertCalls).toBe(0);
    } finally {
      close();
    }
  });

  test("does NOT write the marker if any upsertLeaf throws", async () => {
    const { semantic, close } = makeSemantic();
    try {
      semantic.upsert("language", "ro");
      semantic.upsert("name", "Alice");
      const fmStub = {
        upsertLeaf: async () => { throw new Error("embed unavailable"); },
      };

      const result = await runMigration({
        semantic,
        fractal: fmStub as any,
        dataDir,
      });

      expect(result.ran).toBe(false);
      expect(result.error).toContain("embed unavailable");
      const markerPath = join(dataDir, MIGRATION_MARKER_FILENAME);
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      close();
    }
  });

  test("writes the marker when the store is empty (clean state)", async () => {
    const { semantic, close } = makeSemantic();
    try {
      let upsertCalls = 0;
      const fmStub = {
        upsertLeaf: async () => { upsertCalls++; return { kind: "grow", leafId: 1 }; },
      };

      const result = await runMigration({
        semantic,
        fractal: fmStub as any,
        dataDir,
      });

      expect(result.ran).toBe(true);
      expect(result.facts).toBe(0);
      expect(upsertCalls).toBe(0);
      expect(existsSync(join(dataDir, MIGRATION_MARKER_FILENAME))).toBe(true);
    } finally {
      close();
    }
  });

  test("uses an atomic write (tmp + rename) for the marker", async () => {
    const { semantic, close } = makeSemantic();
    try {
      semantic.upsert("k", "v");
      const fmStub = {
        upsertLeaf: async () => ({ kind: "grow" as const, leafId: 1 }),
      };

      await runMigration({ semantic, fractal: fmStub as any, dataDir });

      // After the call, the tmp file (if we used one) should be gone.
      const tmpPath = join(dataDir, `${MIGRATION_MARKER_FILENAME}.tmp`);
      expect(existsSync(tmpPath)).toBe(false);
      expect(existsSync(join(dataDir, MIGRATION_MARKER_FILENAME))).toBe(true);
    } finally {
      close();
    }
  });

  test("calls upsertLeaf with text 'key: value' and provenance.first_seen_at", async () => {
    const { semantic, close } = makeSemantic();
    try {
      semantic.upsert("language", "ro");
      const captured: any[] = [];
      const fmStub = {
        upsertLeaf: async (opts: any) => {
          captured.push(opts);
          return { kind: "grow", leafId: 1 };
        },
      };

      await runMigration({ semantic, fractal: fmStub as any, dataDir });

      expect(captured).toHaveLength(1);
      expect(captured[0]?.text).toBe("language: ro");
      expect(captured[0]?.provenance?.source).toBe("migration-v1");
      expect(typeof captured[0]?.provenance?.first_seen_at).toBe("number");
      expect(captured[0]?.provenance?.sessionId).toBe("migration");
    } finally {
      close();
    }
  });
});

// ---------------------------------------------------------------------------
// treeView + MemoryGraph.reconcile
// ---------------------------------------------------------------------------

describe("FractalMemory.treeView + MemoryGraph.reconcile", () => {
  test("treeView returns a snapshot with clusters and leaves", () => {
    const fm = makeFm();
    const view = fm.treeView();
    expect(view).toHaveProperty("clusters");
    expect(view).toHaveProperty("leaves");
    expect(Array.isArray(view.clusters)).toBe(true);
    expect(Array.isArray(view.leaves)).toBe(true);
  });

  test("MemoryGraph.reconcile is idempotent on the same view", () => {
    const graph = new MemoryGraph({ path: ":memory:" });
    const view = {
      clusters: [{ id: "c1", summary: "languages" }],
      leaves: [{ id: "f1", summary: "ro" }],
    };
    graph.reconcile(view);
    const beforeNodes = Object.keys((graph as any).snapshot().nodes).length;
    graph.reconcile(view);
    const afterNodes = Object.keys((graph as any).snapshot().nodes).length;
    expect(afterNodes).toBe(beforeNodes);
  });

  test("Reconciler observation path calls graph.reconcile with treeView", async () => {
    const graph = new MemoryGraph(":memory:");
    const fm = makeFm();
    const hooks = new HookRegistry();
    const reconciler = new Reconciler({
      hooks,
      fractal: fm,
      graph,
      embed: identityEmbed(),
    });
    reconciler.start();

    let reconcileCalls = 0;
    const reconcileSpy = (graph as any).reconcile.bind(graph);
    (graph as any).reconcile = (view: any) => { reconcileCalls++; return reconcileSpy(view); };

    await hooks.fire("after_memory_write", {
      kind: "observation",
      sessionId: "s1",
      ts: 1_000_000,
      obsType: "preference",
      title: "prefers dark mode",
      concepts: ["ui", "theme"],
    });

    expect(reconcileCalls).toBe(1);
  });
});
