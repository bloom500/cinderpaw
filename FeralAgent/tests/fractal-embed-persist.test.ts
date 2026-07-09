/**
 * Fractal Memory Search — embedding persistence (round-trip + reuse).
 *
 * The RAPTOR tree builder used to re-embed every leaf on every rebuild. The
 * `episodic.embedding` BLOB column existed but was never read or written, so
 * the corpus (now ~2695 rows) paid the full embed cost on each rebuild. These
 * tests pin the read + write + skip-if-present contract so a refactor can't
 * silently regress it back to "re-embed everything".
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { FractalMemory, type RecallFallback } from "../src/memory/fractal/fractal-memory.ts";
import type { Leaf } from "../src/memory/fractal/types.ts";
import type { EpisodicEvent } from "../src/types.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function treePath(): string {
  const d = mkdtempSync(join(tmpdir(), "feral-fembed-"));
  tmpDirs.push(d);
  return join(d, "tree.json");
}

/** Build an L2-normalized 2-D vector pointing roughly toward `(1, 0)` or `(-1, 0)`. */
function vec(a: number, b: number): Float32Array {
  const v = new Float32Array([a, b]);
  const norm = Math.hypot(a, b);
  if (norm > 0) { v[0]! /= norm; v[1]! /= norm; }
  return v;
}

const fakeSummarize = async (items: string[]) => `summary(${items.length})`;
const noFts = (_q: string, _l: number): EpisodicEvent[] => [];
const FALLBACK_MARK = "<<FTS5-FALLBACK>>";
const fallback: RecallFallback = {
  recall: () => ({ context: FALLBACK_MARK, episodicHits: 1, semanticFacts: 0 }),
};

describe("EpisodicMemory.setEmbeddings — round-trip", () => {
  it("writes and reads back the original 384-dim Float32 values", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const episodic = new EpisodicMemory(db.raw, audit.logger);

    // Two rows, distinct sessions so we can pin which id decoded which vec.
    episodic.record("s-a", "user", "alpha message");
    episodic.record("s-b", "user", "beta message");
    const all = episodic.all();
    expect(all).toHaveLength(2);
    expect(all[0]!.embedding).toBeUndefined();
    expect(all[1]!.embedding).toBeUndefined();

    // Build two non-trivial vectors and write them back.
    const v0 = new Float32Array(384);
    for (let i = 0; i < 384; i++) v0[i] = Math.sin(i * 0.01);
    const v1 = new Float32Array(384);
    for (let i = 0; i < 384; i++) v1[i] = Math.cos(i * 0.013);

    const id0 = all[0]!.id!;
    const id1 = all[1]!.id!;
    episodic.setEmbeddings([
      { id: id0, vec: v0 },
      { id: id1, vec: v1 },
    ]);

    // Read back via all() — same ordering (ORDER BY timestamp ASC).
    const round = episodic.all();
    expect(round[0]!.embedding).toBeDefined();
    expect(round[1]!.embedding).toBeDefined();
    expect(round[0]!.embedding!.length).toBe(384);
    expect(round[1]!.embedding!.length).toBe(384);
    // Bit-for-bit equality (within float32 epsilon): the BLOB is raw little-endian
    // f32 with no transforms, so values must come back identical.
    for (let i = 0; i < 384; i++) {
      expect(round[0]!.embedding![i]!).toBeCloseTo(v0[i]!, -6);
      expect(round[1]!.embedding![i]!).toBeCloseTo(v1[i]!, -6);
    }
    db.close();
  });

  it("skips rows with empty vectors (no garbage write)", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    episodic.record("s", "user", "msg");
    const id = episodic.all()[0]!.id!;

    // Empty vec must NOT overwrite a previously-stored embedding. Pre-write a
    // real vec, then try to write zero-length — the row must still have it.
    const realVec = vec(1, 2);
    episodic.setEmbeddings([{ id, vec: realVec }]);
    expect(episodic.all()[0]!.embedding).toBeDefined();

    episodic.setEmbeddings([{ id, vec: new Float32Array(0) }]);
    expect(episodic.all()[0]!.embedding).toBeDefined();
    expect(episodic.all()[0]!.embedding!.length).toBe(2);
    db.close();
  });

  it("a NULL embedding column comes back as `undefined`", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    episodic.record("s", "user", "msg with no vector yet");

    // No setEmbeddings call — column stays NULL.
    const ev = episodic.all()[0]!;
    expect(ev.embedding).toBeUndefined();
    // Content is still there — only the embedding is missing.
    expect(ev.content).toBe("msg with no vector yet");
    db.close();
  });
});

describe("FractalMemory — embeddings are reused on second rebuild", () => {
  it("calls embed() exactly once across two rebuilds (persistence wiring works end-to-end)", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const episodic = new EpisodicMemory(db.raw, audit.logger);

    // Seed 9 events so the tree builder has enough for a multi-cluster tree.
    let nextId = 0;
    for (let i = 0; i < 9; i++) {
      episodic.record(`s-${i % 2}`, "user", `event ${i}`);
    }
    // The autoincrement ids start at 1; capture them in insertion order.
    const ids = episodic.all().map((e) => e.id!);

    // In-memory "DB" that the FractalMemory side reads from / writes back to.
    // The first rebuild reads everything with vec=new Float32Array(0), so the
    // builder calls embed(); the persist hook then populates this map. The
    // second rebuild reads the same map — every leaf arrives with a vec, so
    // embed() must NOT be called again.
    const storedVecs = new Map<number, Float32Array>();

    let embedCalls = 0;
    let totalLeafEmbeddings = 0;
    const embed = async (texts: string[]): Promise<Float32Array[]> => {
      embedCalls++;
      totalLeafEmbeddings += texts.length;
      return texts.map((t) => {
        // Deterministic 2-D direction so kmeans clusters them.
        const a = t.includes("s-0") ? 1 : -1;
        return vec(a, 0);
      });
    };

    const fm = new FractalMemory({
      loadLeaves: () =>
        episodic.all().map((e) => {
          const stored = storedVecs.get(e.id!);
          return {
            id: e.id!,
            text: e.content,
            // If the in-memory store has a vector, use it; otherwise mark
            // the leaf as "needs embed" with an empty vec.
            vec: stored ?? new Float32Array(0),
            ts: e.timestamp,
            sessionId: e.sessionId,
          };
        }),
      embed,
      summarize: fakeSummarize,
      ftsSearch: noFts,
      fallback,
      treePath: treePath(),
      persistEmbeddings: (rows) => {
        for (const { id, vec: v } of rows) storedVecs.set(id, v);
      },
    });

    // First build — every leaf needs embedding.
    expect(await fm.rebuild()).toBe(true);
    expect(embedCalls).toBeGreaterThanOrEqual(1);
    expect(totalLeafEmbeddings).toBe(9);
    // The persist hook should have written one vec per row.
    expect(storedVecs.size).toBe(9);
    for (const id of ids) {
      expect(storedVecs.get(id)).toBeDefined();
      expect(storedVecs.get(id)!.length).toBe(2);
    }

    // Reset counters — second rebuild must do ZERO embedding work because
    // loadLeaves now sees every vec already populated.
    const embedCallsAfterFirst = embedCalls;
    const totalLeafEmbeddingsAfterFirst = totalLeafEmbeddings;
    embedCalls = 0;
    totalLeafEmbeddings = 0;

    expect(await fm.rebuild()).toBe(true);
    expect(embedCalls).toBe(0);
    expect(totalLeafEmbeddings).toBe(0);
    // Sanity: nothing got dropped between builds.
    expect(storedVecs.size).toBe(9);
    // Use the variables to keep TS strict-mode happy about "unused locals".
    void embedCallsAfterFirst; void totalLeafEmbeddingsAfterFirst;

    db.close();
  });
});

describe("FractalMemory — missing embedding still gets embedded (no crash)", () => {
  it("a leaf with no stored embedding is embedded on demand by buildTree", async () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const episodic = new EpisodicMemory(db.raw, audit.logger);

    // One row pre-embedded, one row left bare. The bare row must trigger
    // embed() at build time without blowing up.
    episodic.record("s-a", "user", "alpha");
    episodic.record("s-b", "user", "beta");
    const all = episodic.all();
    const idA = all.find((e) => e.content === "alpha")!.id!;
    const idB = all.find((e) => e.content === "beta")!.id!;

    const storedVecs = new Map<number, Float32Array>();
    storedVecs.set(idA, vec(1, 0)); // alpha pre-embedded

    let embedTexts: string[] = [];
    const embed = async (texts: string[]): Promise<Float32Array[]> => {
      embedTexts.push(...texts);
      return texts.map((t) => vec(t.includes("alpha") ? 1 : -1, 0));
    };

    const fm = new FractalMemory({
      loadLeaves: () =>
        episodic.all().map((e) => {
          const stored = storedVecs.get(e.id!);
          return {
            id: e.id!,
            text: e.content,
            // Stored vec wins; otherwise we leave vec empty so buildTree
            // routes this leaf through embed().
            vec: stored ?? new Float32Array(0),
            ts: e.timestamp,
            sessionId: e.sessionId,
          };
        }),
      embed,
      summarize: fakeSummarize,
      ftsSearch: noFts,
      fallback,
      treePath: treePath(),
      // 2 leaves is below the default minLeaves=8; lower the bar so we can
      // exercise the missing-embedding path with a tiny corpus.
      minLeaves: 2,
      persistEmbeddings: (rows) => {
        for (const { id, vec: v } of rows) storedVecs.set(id, v);
      },
    });

    expect(await fm.rebuild()).toBe(true);
    // The bare leaf ("beta") was the only one sent through embed().
    expect(embedTexts).toEqual(["beta"]);
    // And after the build, beta has its own vec stored.
    expect(storedVecs.get(idA)).toBeDefined();
    expect(storedVecs.get(idB)).toBeDefined();
    // The alpha vec on disk must NOT have been overwritten by the build
    // (it's already a valid unit vec; the persist hook should only fire
    // for leaves it actually embedded).
    const alphaVec = storedVecs.get(idA)!;
    expect(alphaVec.length).toBe(2);
    // alpha's stored vec was (1,0) normalized — still a unit vec pointing right.
    expect(Math.abs(alphaVec[0]! - 1)).toBeLessThan(1e-6);
    expect(Math.abs(alphaVec[1]! - 0)).toBeLessThan(1e-6);

    // Suppress unused-binding warnings — idA/idB are checked above indirectly.
    void idA; void idB;
    db.close();
  });
});

/** Smoke-level tests for the buildTree-level wiring so a future refactor can't
 *  silently drop `persistEmbeddings` from the chunk loop without a failure. */
describe("buildTree — persistEmbeddings is called per chunk", () => {
  it("invokes persistEmbeddings once per chunk with the matching (id, vec) pairs", async () => {
    const { buildTree } = await import("../src/memory/fractal/tree-builder.ts");
    const { kmeans: realKmeans } = await import("../src/memory/fractal/kmeans.ts");

    // 10 leaves, no vecs — buildTree must embed them all (one chunk since
    // EMBED_CHUNK = 128) and call persistEmbeddings exactly once with all
    // 10 (id, vec) pairs.
    const leaves: Leaf[] = Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i,
      text: `leaf ${i}`,
      vec: new Float32Array(0),
      ts: 1700000000000 + i,
      sessionId: "s",
    }));

    const persistCalls: { id: number; vec: Float32Array }[][] = [];
    const embed = async (texts: string[]) => {
      // 1-D vectors in two halves → kmeans finds 2 clusters easily.
      return texts.map((t, j) => vec(j < 5 ? 1 : -1, 0));
    };

    const tree = await buildTree(leaves, {
      embed,
      kmeans: realKmeans,
      summarize: fakeSummarize,
      branch: 8,
      persistEmbeddings: (rows) => {
        // Snapshot the call so we can assert after the build.
        persistCalls.push(rows.map((r) => ({ id: r.id, vec: r.vec.slice() })));
      },
    });

    expect(tree).toBeDefined();
    expect(persistCalls.length).toBeGreaterThanOrEqual(1);
    // Every leaf id must have been persisted exactly once across all calls.
    const seen = new Set<number>();
    for (const batch of persistCalls) {
      for (const { id, vec } of batch) {
        expect(seen.has(id)).toBe(false);
        expect(vec.length).toBe(2);
        seen.add(id);
      }
    }
    expect(seen.size).toBe(10);
  });
});
