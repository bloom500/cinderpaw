/**
 * Benchmark query-set generation.
 *
 * Two ways to obtain the labelled queries the runner scores against:
 *
 *   1. `parseQuerySet` — load a hand-authored JSONL file of
 *      `{query, relevant: number[]}`. This is the gold path when Darius has
 *      real labelled queries.
 *   2. `generateQuerySet` — self-supervised, BEIR-style: deterministically
 *      sample memories, ask the local model to paraphrase each into a query a
 *      user might ask, and label the source memory as the single relevant doc.
 *      Free (local model), reproducible (seeded sampling), and unbiased
 *      between FTS5 and the fractal because the paraphrase varies the wording.
 *
 * `infer` is injected so tests never touch a real model.
 */
import { describe, it, expect } from "bun:test";
import { parseQuerySet, generateQuerySet } from "../src/memory/fractal/bench/query-gen.ts";

describe("parseQuerySet", () => {
  it("parses JSONL lines into BenchQuery with a relevant Set", () => {
    const jsonl = [
      `{"query":"how do I deploy","relevant":[3,7]}`,
      `{"query":"reset password","relevant":[12]}`,
    ].join("\n");
    const set = parseQuerySet(jsonl);
    expect(set).toHaveLength(2);
    expect(set[0]!.query).toBe("how do I deploy");
    expect(set[0]!.relevant).toEqual(new Set([3, 7]));
    expect(set[1]!.relevant).toEqual(new Set([12]));
  });

  it("ignores blank lines and surrounding whitespace", () => {
    const jsonl = `\n  {"query":"a","relevant":[1]}  \n\n`;
    expect(parseQuerySet(jsonl)).toHaveLength(1);
  });

  it("throws on a line missing the relevant field", () => {
    expect(() => parseQuerySet(`{"query":"a"}`)).toThrow();
  });

  it("throws on a line with an empty query", () => {
    expect(() => parseQuerySet(`{"query":"  ","relevant":[1]}`)).toThrow();
  });
});

describe("generateQuerySet", () => {
  const leaves = Array.from({ length: 10 }, (_, i) => ({
    id: 100 + i,
    text: `Memory number ${i} about a distinct topic with enough words to matter`,
  }));

  it("labels each generated query with its source memory id", async () => {
    const infer = async (prompt: string) => `Q(${prompt.length})`;
    const set = await generateQuerySet({ leaves, infer, count: 3, seed: 1 });
    expect(set).toHaveLength(3);
    for (const q of set) {
      expect(q.relevant.size).toBe(1);
      const [id] = [...q.relevant];
      expect(leaves.some((l) => l.id === id)).toBe(true);
    }
  });

  it("feeds the memory text to the model so the query is about that memory", async () => {
    const seen: string[] = [];
    const infer = async (prompt: string) => { seen.push(prompt); return "a question"; };
    await generateQuerySet({ leaves, infer, count: 2, seed: 1 });
    // Each prompt embeds the source memory's text.
    expect(seen).toHaveLength(2);
    expect(seen.some((p) => /Memory number/.test(p))).toBe(true);
  });

  it("is deterministic: same seed samples the same memory ids", async () => {
    const infer = async () => "q";
    const a = await generateQuerySet({ leaves, infer, count: 4, seed: 42 });
    const b = await generateQuerySet({ leaves, infer, count: 4, seed: 42 });
    const ids = (s: typeof a) => s.flatMap((q) => [...q.relevant]);
    expect(ids(a)).toEqual(ids(b));
  });

  it("different seeds sample a different selection", async () => {
    const infer = async () => "q";
    const a = await generateQuerySet({ leaves, infer, count: 4, seed: 1 });
    const b = await generateQuerySet({ leaves, infer, count: 4, seed: 999 });
    const ids = (s: typeof a) => [...s.flatMap((q) => [...q.relevant])].sort((x, y) => x - y);
    expect(ids(a)).not.toEqual(ids(b));
  });

  it("trims the model output and drops queries that come back empty", async () => {
    // Model returns whitespace for the first call, real text afterwards.
    let n = 0;
    const infer = async () => (n++ === 0 ? "   \n  " : "  real query  ");
    const set = await generateQuerySet({ leaves, infer, count: 3, seed: 1 });
    // One dropped → 2 remain, and the kept ones are trimmed.
    expect(set).toHaveLength(2);
    for (const q of set) expect(q.query).toBe("real query");
  });

  it("skips memories shorter than minLen before sampling", async () => {
    const mixed = [
      { id: 1, text: "hi" },
      { id: 2, text: "ok" },
      { id: 3, text: "this is a sufficiently long memory to be worth a query" },
    ];
    const infer = async () => "q";
    const set = await generateQuerySet({ leaves: mixed, infer, count: 10, seed: 1, minLen: 20 });
    // Only id=3 is eligible.
    expect(set).toHaveLength(1);
    expect([...set[0]!.relevant]).toEqual([3]);
  });

  it("caps at the number of eligible memories when count exceeds it", async () => {
    const infer = async () => "q";
    const set = await generateQuerySet({ leaves: leaves.slice(0, 3), infer, count: 50, seed: 1 });
    expect(set).toHaveLength(3);
  });
});
