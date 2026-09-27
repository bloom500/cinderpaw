/**
 * The memory page's Forget and the `remember` tool's forget clear every copy
 * of a fact: the SemanticMemory row, the knowledge-graph edge, the tree leaf.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetEdge, forgetMirrors } from "../src/memory/forget.ts";
import { MemoryGraph } from "../src/memory/graph.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { openDatabase } from "../src/db.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function targets() {
  const d = mkdtempSync(join(tmpdir(), "cp-forget-"));
  dirs.push(d);
  const db = openDatabase(":memory:");
  const forgotten: string[] = [];
  return {
    graph: new MemoryGraph(join(d, "g.json")),
    semantic: new SemanticMemory(db.raw, () => {}),
    fractal: { forgetFact: (k: string) => { forgotten.push(k); return [1]; } },
    forgotten,
  };
}

describe("forgetEdge — the memory page's Forget", () => {
  it("removes the edge, the fact it mirrors, and the fact's leaf", () => {
    const t = targets();
    t.semantic.upsert("city", "Lisbon");
    t.graph.setFact("city", "has", "Lisbon");
    expect(forgetEdge(t, { from: "city", to: "lisbon", relation: "has" })).toBe(1);
    expect(t.graph.snapshot().edges).toHaveLength(0);
    expect(t.semantic.get("city")).toBeUndefined();
    expect(t.forgotten).toEqual(["city"]);
  });

  it("leaves a newer value alone", () => {
    const t = targets();
    t.graph.addFact("city", "has", "Paris"); // stale edge from before setFact existed
    t.semantic.upsert("city", "London");
    forgetEdge(t, { from: "city", to: "paris", relation: "has" });
    expect(t.semantic.get("city")?.value).toBe("London");
    expect(t.forgotten).toEqual([]);
  });

  it("an edge that is not a mirrored fact touches only the graph", () => {
    const t = targets();
    t.semantic.upsert("city", "Lisbon");
    t.graph.addEdge("city", "lisbon", "discovery");
    forgetEdge(t, { from: "city", to: "lisbon", relation: "discovery" });
    expect(t.semantic.get("city")?.value).toBe("Lisbon");
  });
});

describe("forgetMirrors — after remember forget:true", () => {
  it("clears the graph edge and the leaf", () => {
    const t = targets();
    t.graph.setFact("phone", "has", "0721");
    forgetMirrors(t, "phone");
    expect(t.graph.snapshot().edges).toHaveLength(0);
    expect(t.forgotten).toEqual(["phone"]);
  });
});
