/**
 * Tree-store (TDD) — persistence for the RAPTOR tree.
 *
 * The tree is built offline/incrementally and reused across queries, so it
 * must survive a process restart. `TreeNode` holds `Float32Array` centroids
 * which JSON cannot represent directly; the store converts them to/from
 * `number[]` and round-trips the whole structure through a versioned envelope.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  serializeTree,
  deserializeTree,
  saveTree,
  loadTree,
  TREE_STORE_VERSION,
} from "../src/memory/fractal/tree-store.ts";
import type { TreeNode } from "../src/memory/fractal/types.ts";

/** A small two-level tree: root over two leaf-clusters. */
function sampleTree(): TreeNode {
  const leafA: TreeNode = {
    id: "L0-1",
    level: 0,
    centroid: new Float32Array([1, 0]),
    summary: "",
    children: [],
    leafIds: [1],
  };
  const leafB: TreeNode = {
    id: "L0-2",
    level: 0,
    centroid: new Float32Array([0, 1]),
    summary: "",
    children: [],
    leafIds: [2],
  };
  return {
    id: "root",
    level: 1,
    centroid: new Float32Array([0.7071, 0.7071]),
    summary: "root summary",
    children: [leafA, leafB],
    leafIds: [1, 2],
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cinderpaw-tree-"));
  tmpDirs.push(d);
  return d;
}

describe("tree-store — serialize/deserialize", () => {
  it("round-trips structure (ids, levels, summaries, leafIds)", () => {
    const tree = sampleTree();
    const back = deserializeTree(serializeTree(tree));
    expect(back.id).toBe("root");
    expect(back.level).toBe(1);
    expect(back.summary).toBe("root summary");
    expect(back.leafIds).toEqual([1, 2]);
    expect(back.children.map((c) => c.id)).toEqual(["L0-1", "L0-2"]);
    expect(back.children[0]!.leafIds).toEqual([1]);
  });

  it("centroids come back as Float32Array with the same values", () => {
    const back = deserializeTree(serializeTree(sampleTree()));
    expect(back.centroid).toBeInstanceOf(Float32Array);
    expect(back.children[0]!.centroid).toBeInstanceOf(Float32Array);
    expect(Array.from(back.children[1]!.centroid)).toEqual([0, 1]);
    // Float32 precision: the root centroid round-trips closely.
    expect(back.centroid[0]).toBeCloseTo(0.7071, 4);
  });

  it("serialized centroids are plain number[] (JSON-safe)", () => {
    const s = serializeTree(sampleTree());
    expect(Array.isArray(s.centroid)).toBe(true);
    expect(typeof s.centroid[0]).toBe("number");
    // It must actually JSON-stringify without throwing or producing {}.
    const json = JSON.stringify(s);
    expect(json).toContain("\"root summary\"");
    expect(json).not.toContain("Float32Array");
  });
});

describe("tree-store — save/load", () => {
  it("saves to disk and loads an identical tree", () => {
    const dir = freshDir();
    const path = join(dir, "tree.json");
    saveTree(path, sampleTree());
    expect(existsSync(path)).toBe(true);
    const loaded = loadTree(path);
    expect(loaded).not.toBeNull();
    expect(loaded!.tree.id).toBe("root");
    expect(loaded!.tree.children[1]!.centroid).toBeInstanceOf(Float32Array);
    expect(loaded!.version).toBe(TREE_STORE_VERSION);
    expect(loaded!.leafCount).toBe(2);
    expect(loaded!.builtAt).toBeGreaterThan(0);
  });

  it("loadTree returns null for a missing file (no throw)", () => {
    const dir = freshDir();
    expect(loadTree(join(dir, "does-not-exist.json"))).toBeNull();
  });

  it("loadTree returns null for a version mismatch (stale tree ignored)", () => {
    const dir = freshDir();
    const path = join(dir, "tree.json");
    saveTree(path, sampleTree());
    // Corrupt the version on disk to simulate an older build.
    const raw = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
    raw.version = TREE_STORE_VERSION - 1;
    require("node:fs").writeFileSync(path, JSON.stringify(raw));
    expect(loadTree(path)).toBeNull();
  });

  it("loadTree returns null for corrupt JSON (no throw)", () => {
    const dir = freshDir();
    const path = join(dir, "tree.json");
    require("node:fs").writeFileSync(path, "{ not valid json");
    expect(loadTree(path)).toBeNull();
  });
});
