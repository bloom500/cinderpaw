/**
 * memory_ops — fractal facade over its `search` action.
 *
 * `memory_ops search` historically only matched the small semantic-fact
 * key/value store. With the optional fractal episodic search injected, it ALSO
 * surfaces semantically-relevant past conversations — without changing its
 * output contract: the same `{ok, content, data}` shape, the fact matches
 * still present, and the episodic section appended only when there are hits.
 * No fractal dep (or zero hits) → byte-for-byte the old behavior.
 *
 * Only `search` is augmented; CRUD actions (add/forget/list/get) are untouched.
 */
import { describe, it, expect } from "bun:test";
import { createMemoryOpsTool, type EpisodicSemanticSearch } from "../src/tools/builtin/memory-ops.ts";
import type { SemanticMemory, SemanticFact } from "../src/memory/semantic.ts";

/** Minimal in-memory SemanticMemory fake — only what the tool touches. */
function fakeSemantic(facts: SemanticFact[]): SemanticMemory {
  const map = new Map(facts.map((f) => [f.key, f]));
  return {
    get: (k: string) => map.get(k),
    all: () => [...map.values()],
    upsert: (k: string, v: string) => { map.set(k, { key: k, value: v } as SemanticFact); },
    delete: (k: string) => { map.delete(k); },
  } as unknown as SemanticMemory;
}

const FACTS: SemanticFact[] = [
  { key: "editor", value: "prefers dark mode" } as SemanticFact,
  { key: "city", value: "lives in Cluj" } as SemanticFact,
];

describe("memory_ops search — no fractal dep (legacy behavior preserved)", () => {
  it("returns only the matching facts, unchanged shape", async () => {
    const tool = createMemoryOpsTool(fakeSemantic(FACTS));
    const res = await tool.execute({ action: "search", query: "dark" });
    expect(res.ok).toBe(true);
    expect(res.content).toContain("editor: prefers dark mode");
    expect(res.content).not.toMatch(/past conversation/i);
    expect((res.data as { hits: unknown[] }).hits).toHaveLength(1);
  });
});

describe("memory_ops search — with fractal episodic search", () => {
  const fractal: EpisodicSemanticSearch = async (q, limit) => {
    expect(q).toBe("deploy");
    expect(limit).toBeGreaterThan(0);
    return [
      { leafId: 41, text: "we deployed the release through the updater" },
      { leafId: 88, text: "the deploy failed on the signature step" },
    ];
  };

  it("appends related past conversations and keeps the fact matches", async () => {
    const tool = createMemoryOpsTool(fakeSemantic(FACTS), fractal);
    const res = await tool.execute({ action: "search", query: "deploy" });
    expect(res.ok).toBe(true);
    // Episodic hits are surfaced...
    expect(res.content.toLowerCase()).toMatch(/past conversation/);
    expect(res.content).toContain("deployed the release");
    // ...and exposed structurally for callers.
    expect((res.data as { episodic: unknown[] }).episodic).toHaveLength(2);
  });

  it("when the fractal search returns nothing, output is the legacy shape", async () => {
    const empty: EpisodicSemanticSearch = async () => [];
    const tool = createMemoryOpsTool(fakeSemantic(FACTS), empty);
    const res = await tool.execute({ action: "search", query: "dark" });
    expect(res.content).toContain("editor: prefers dark mode");
    expect(res.content).not.toMatch(/past conversation/i);
  });

  it("does not invoke fractal search for non-search actions", async () => {
    let called = false;
    const spy: EpisodicSemanticSearch = async () => { called = true; return []; };
    const tool = createMemoryOpsTool(fakeSemantic(FACTS), spy);
    await tool.execute({ action: "list" });
    await tool.execute({ action: "get", key: "city" });
    expect(called).toBe(false);
  });
});
