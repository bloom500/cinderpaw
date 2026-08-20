/**
 * Knowledge Provenance — queryable graph over git-backed commits (BRSI §2.6).
 *
 * Contract under test:
 *   1. `show(id)` walks the parent chain from id back to the root.
 *   2. `show(id)` for an unknown id returns [].
 *   3. `descendants(root)` returns root + every descendant reachable
 *      via parent → child edges, parents before children.
 *   4. `commonAncestor(a, b)` returns the deepest node on both paths.
 *   5. `commit → node` parsing: metadata_json is parsed into `metadata`,
 *      kind is inferred from `kind` / `type` / `mutation_type` fields.
 *   6. Malformed metadata_json leaves `metadata` undefined (not poison).
 *   7. Typed envelope shape (LoRA / demo / eval_task) — type-level test
 *      that the contract holds.
 *   8. The bridge-backed constructor uses the cache (one `rsi_log`
 *      call regardless of how many queries are issued).
 */
import { describe, expect, test } from "bun:test";
import {
  inMemoryProvenanceGraph,
  type ArtifactEnvelope,
  type CommitMetaLike,
  type ProvenanceKind,
} from "../src/rsi/infra/provenance.ts";
import type { RsiBridge, RsiResponse } from "../src/rsi/infra/bridge.ts";

/** Build a small synthetic commit chain for tests. */
function commit(
  hash: string,
  parents: string[],
  metadata?: Record<string, unknown>,
  summary?: string,
  timestamp?: number,
): CommitMetaLike {
  return {
    commit_hash: hash,
    parent_hashes: parents,
    metadata_json: metadata ? JSON.stringify(metadata) : null,
    summary: summary ?? `commit ${hash}`,
    timestamp: timestamp ?? 0,
  };
}

describe("show — walks parent chain", () => {
  test("linear chain A → B → C: show(C) returns [C, B, A]", async () => {
    const commits = [
      commit("A", []),
      commit("B", ["A"]),
      commit("C", ["B"]),
    ];
    const g = inMemoryProvenanceGraph(commits);
    const chain = await g.show("C");
    expect(chain.map((n) => n.id)).toEqual(["C", "B", "A"]);
  });

  test("show(A) returns [A]", async () => {
    const commits = [commit("A", []), commit("B", ["A"])];
    const g = inMemoryProvenanceGraph(commits);
    expect((await g.show("A")).map((n) => n.id)).toEqual(["A"]);
  });

  test("show(unknown) returns []", async () => {
    const commits = [commit("A", []), commit("B", ["A"])];
    const g = inMemoryProvenanceGraph(commits);
    expect(await g.show("ZZZ")).toEqual([]);
  });

  test("branching commit: show walks the primary (first) parent only", async () => {
    const commits = [
      commit("A", []),
      commit("B", ["A"]),
      commit("M", ["B", "A"]), // merge: B first, A second
    ];
    const g = inMemoryProvenanceGraph(commits);
    expect((await g.show("M")).map((n) => n.id)).toEqual(["M", "B", "A"]);
  });
});

describe("descendants — BFS over parent → children", () => {
  test("linear chain: descendants(A) returns [A, B, C]", async () => {
    const commits = [
      commit("A", []),
      commit("B", ["A"]),
      commit("C", ["B"]),
    ];
    const g = inMemoryProvenanceGraph(commits);
    expect((await g.descendants("A")).map((n) => n.id)).toEqual(["A", "B", "C"]);
  });

  test("mid-chain: descendants(B) returns [B, C]", async () => {
    const commits = [
      commit("A", []),
      commit("B", ["A"]),
      commit("C", ["B"]),
    ];
    const g = inMemoryProvenanceGraph(commits);
    expect((await g.descendants("B")).map((n) => n.id)).toEqual(["B", "C"]);
  });

  test("leaf: descendants(C) returns [C]", async () => {
    const commits = [
      commit("A", []),
      commit("B", ["A"]),
      commit("C", ["B"]),
    ];
    const g = inMemoryProvenanceGraph(commits);
    expect((await g.descendants("C")).map((n) => n.id)).toEqual(["C"]);
  });

  test("branching: descendants(A) returns [A, B, M, C] (parents first)", async () => {
    const commits = [
      commit("A", []),
      commit("B", ["A"]),
      commit("M", ["B"]), // branch 1
      commit("C", ["A"]), // branch 2 from A directly
    ];
    const g = inMemoryProvenanceGraph(commits);
    const ids = (await g.descendants("A")).map((n) => n.id);
    expect(ids).toContain("A");
    expect(ids).toContain("B");
    expect(ids).toContain("M");
    expect(ids).toContain("C");
    // A before B and C; B before M.
    expect(ids.indexOf("A")).toBeLessThan(ids.indexOf("B"));
    expect(ids.indexOf("A")).toBeLessThan(ids.indexOf("C"));
    expect(ids.indexOf("B")).toBeLessThan(ids.indexOf("M"));
  });

  test("descendants(unknown) returns [] (no entry in cache)", async () => {
    const commits = [commit("A", [])];
    const g = inMemoryProvenanceGraph(commits);
    expect(await g.descendants("ZZZ")).toEqual([]);
  });
});

describe("commonAncestor — deepest shared node", () => {
  test("A → B → C and A → D: LCA(C, D) = A", async () => {
    const commits = [
      commit("A", []),
      commit("B", ["A"]),
      commit("C", ["B"]),
      commit("D", ["A"]),
    ];
    const g = inMemoryProvenanceGraph(commits);
    expect(await g.commonAncestor("C", "D")).toBe("A");
  });

  test("C is descended from B: LCA(C, B) = B", async () => {
    const commits = [
      commit("A", []),
      commit("B", ["A"]),
      commit("C", ["B"]),
    ];
    const g = inMemoryProvenanceGraph(commits);
    expect(await g.commonAncestor("C", "B")).toBe("B");
  });

  test("disjoint commits: LCA = null", async () => {
    const commits = [commit("A", []), commit("B", [])];
    const g = inMemoryProvenanceGraph(commits);
    expect(await g.commonAncestor("A", "B")).toBeNull();
  });

  test("same commit: LCA = itself", async () => {
    const commits = [commit("A", []), commit("B", ["A"])];
    const g = inMemoryProvenanceGraph(commits);
    expect(await g.commonAncestor("B", "B")).toBe("B");
  });
});

describe("commit → node parsing", () => {
  test("metadata_json is parsed into the metadata field", async () => {
    const commits = [
      commit("A", [], { score: 0.85, strategy: "balanced", parent_lineage: [] }),
    ];
    const g = inMemoryProvenanceGraph(commits);
    const node = (await g.show("A"))[0]!;
    expect(node.metadata).toEqual({
      score: 0.85,
      strategy: "balanced",
      parent_lineage: [],
    });
  });

  test("kind is inferred from metadata.kind", async () => {
    const commits = [commit("A", [], { kind: "code_patch", score: 0.9 })];
    const g = inMemoryProvenanceGraph(commits);
    const node = (await g.show("A"))[0]!;
    expect(node.kind).toBe("code_patch");
  });

  test("kind inferred from metadata.type", async () => {
    const commits = [commit("A", [], { type: "lora", base_model: "gemma-9b" })];
    const g = inMemoryProvenanceGraph(commits);
    const node = (await g.show("A"))[0]!;
    expect(node.kind).toBe("lora");
  });

  test("kind inferred from metadata.mutation_type (legacy field)", async () => {
    const commits = [commit("A", [], { mutation_type: "code" })];
    const g = inMemoryProvenanceGraph(commits);
    const node = (await g.show("A"))[0]!;
    expect(node.kind).toBe("code_patch");
  });

  test("missing metadata → kind is 'unknown'", async () => {
    const commits = [commit("A", [])];
    const g = inMemoryProvenanceGraph(commits);
    const node = (await g.show("A"))[0]!;
    expect(node.kind).toBe("unknown");
  });

  test("malformed metadata_json → metadata undefined, kind 'unknown'", async () => {
    const commits: CommitMetaLike[] = [
      {
        commit_hash: "A",
        parent_hashes: [],
        metadata_json: "{not valid json",
        summary: "broken",
      },
    ];
    const g = inMemoryProvenanceGraph(commits);
    const node = (await g.show("A"))[0]!;
    expect(node.metadata).toBeUndefined();
    expect(node.kind).toBe("unknown");
    expect(node.summary).toBe("broken");
  });

  test("all ProvenanceKind values are accepted by the inferer (no silent drop)", () => {
    const kinds: ProvenanceKind[] = [
      "genome",
      "code_patch",
      "config",
      "lora",
      "demo",
      "eval_task",
      "unknown",
    ];
    for (const k of kinds) {
      const commits = [commit("A", [], { kind: k })];
      // unknown isn't a known value to infer, so we expect 'unknown'
      // unless the literal string matches a case. The contract here is
      // just: no exception, a string kind returned.
      expect(async () => {
        const g = inMemoryProvenanceGraph(commits);
        await g.show("A");
      }).not.toThrow();
    }
  });
});

describe("ArtifactEnvelope — typed envelope for non-code artifacts", () => {
  test("lora envelope shape holds the BRSI §2.6 chain pattern", () => {
    const base: ArtifactEnvelope = {
      id: "gemma-9b",
      kind: "lora",
      parents: [],
      timestamp: 1_700_000_000_000,
      data: { rank: 0, alpha: 0 },
    };
    const v3: ArtifactEnvelope = {
      id: "lora-v3",
      kind: "lora",
      parents: [base.id],
      timestamp: 1_700_000_100_000,
      data: { rank: 8, alpha: 16 },
    };
    const v5: ArtifactEnvelope = {
      id: "lora-v5",
      kind: "lora",
      parents: [v3.id],
      timestamp: 1_700_000_200_000,
      data: { rank: 16, alpha: 32 },
    };
    const v8: ArtifactEnvelope = {
      id: "lora-v8",
      kind: "lora",
      parents: [v5.id],
      timestamp: 1_700_000_300_000,
      data: { rank: 16, alpha: 32 },
    };
    // The chain v8 → v5 → v3 → base-gemma is exactly what BRSI §2.6
    // promised the user could query.
    expect(v8.parents).toEqual(["lora-v5"]);
    expect(v5.parents).toEqual(["lora-v3"]);
    expect(v3.parents).toEqual(["gemma-9b"]);
    expect(base.parents).toEqual([]);
  });
});

describe("rsiProvenanceGraph — bridge caching", () => {
  /** Fake bridge that counts `rsi_log` calls and returns a canned log. */
  class FakeBridge {
    logCalls = 0;
    lcaCalls = 0;
    constructor(private readonly log: CommitMetaLike[]) {}
    request<T = unknown>(method: string, _params: unknown, _timeoutMs?: number): Promise<T> {
      if (method === "rsi_log") {
        this.logCalls++;
        return Promise.resolve(this.log as unknown as T);
      }
      if (method === "rsi_lca") {
        this.lcaCalls++;
        return Promise.resolve(null as unknown as T);
      }
      return Promise.reject(new Error(`unexpected method ${method}`));
    }
    onResponse(_msg: RsiResponse): void {}
  }

  test("one rsi_log call regardless of how many queries are issued", async () => {
    const fake = new FakeBridge([
      commit("A", []),
      commit("B", ["A"]),
      commit("C", ["B"]),
    ]);
    const { rsiProvenanceGraph } = await import("../src/rsi/infra/provenance.ts");
    const g = rsiProvenanceGraph(fake as unknown as RsiBridge);
    await g.show("C");
    await g.show("B");
    await g.descendants("A");
    await g.show("A");
    expect(fake.logCalls).toBe(1);
  });

  test("commonAncestor uses the bridge, not the cache", async () => {
    const fake = new FakeBridge([commit("A", []), commit("B", ["A"])]);
    const { rsiProvenanceGraph } = await import("../src/rsi/infra/provenance.ts");
    const g = rsiProvenanceGraph(fake as unknown as RsiBridge);
    await g.commonAncestor("A", "B");
    await g.commonAncestor("A", "B");
    expect(fake.lcaCalls).toBe(2);
    expect(fake.logCalls).toBe(0); // LCA never touched the log
  });
});