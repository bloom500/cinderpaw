/**
 * Benchmark query-set generation.
 *
 * The benchmark gate needs labelled queries: text plus the leaf ids that
 * should be retrieved. There are no human relevance labels in the episodic
 * history, so we support two sources:
 *
 *   - `parseQuerySet`: load a hand-authored JSONL file (the gold standard when
 *     real labels exist).
 *   - `generateQuerySet`: self-supervised, BEIR-style. Deterministically
 *     sample memories, ask the local model to paraphrase each into a query a
 *     user might ask, and treat the source memory as the single relevant doc.
 *     The paraphrase varies the wording, so the eval is not biased toward
 *     either lexical (FTS5) or semantic (fractal) retrieval — which is exactly
 *     the regime the gate is meant to discriminate.
 *
 * CAVEAT (carried into the report): a single-gold self-supervised set measures
 * "can the system find the memory this query was written from", not full human
 * relevance. It is the honest free default; a hand-labelled JSONL via
 * `parseQuerySet` supersedes it whenever one exists.
 */
import type { BenchQuery } from "./runner.ts";

/** A memory eligible to seed a query — just id + text. */
export interface GenLeaf {
  id: number;
  text: string;
}

export interface GenerateOptions {
  leaves: GenLeaf[];
  /** Local-model call: prompt → completion. Injected so tests stay offline. */
  infer: (prompt: string) => Promise<string>;
  /** How many queries to generate (capped at the eligible memory count). */
  count: number;
  /** Seed for the deterministic sampler (default 1). */
  seed?: number;
  /** Skip memories whose text is shorter than this (default 20 chars). */
  minLen?: number;
}

/**
 * Parse a JSONL query set: one `{query: string, relevant: number[]}` object
 * per non-blank line. Throws on a missing/empty query or a missing relevant
 * array — a malformed benchmark file should fail loudly, not silently skew the
 * gate.
 */
export function parseQuerySet(jsonl: string): BenchQuery[] {
  const out: BenchQuery[] = [];
  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const obj = JSON.parse(line) as { query?: unknown; relevant?: unknown };
    if (typeof obj.query !== "string" || obj.query.trim() === "") {
      throw new Error(`parseQuerySet: missing/empty "query" in line: ${line}`);
    }
    if (!Array.isArray(obj.relevant)) {
      throw new Error(`parseQuerySet: missing "relevant" array in line: ${line}`);
    }
    out.push({ query: obj.query.trim(), relevant: new Set(obj.relevant as number[]) });
  }
  return out;
}

/** Deterministic PRNG (mulberry32) — same seed → same stream. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded partial Fisher–Yates: the first `count` of a shuffled copy. */
function sample<T>(items: T[], count: number, seed: number): T[] {
  const rand = mulberry32(seed);
  const arr = [...items];
  const n = Math.min(count, arr.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (arr.length - i));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr.slice(0, n);
}

/** Prompt the model to turn a memory into a realistic user query. */
function queryPrompt(memory: string): string {
  return [
    "Below is a memory from a past conversation. Write ONE short, natural",
    "question a user might later ask whose answer is this memory. Vary the",
    "wording — do not copy the memory's phrasing. Reply with the question only.",
    "",
    `Memory: ${memory}`,
  ].join("\n");
}

/**
 * Generate a self-supervised labelled query set. Eligible memories (>= minLen)
 * are sampled deterministically; each is paraphrased into a query via `infer`
 * and labelled with its own id. Queries whose generation comes back empty are
 * dropped (a blank query measures nothing).
 */
export async function generateQuerySet(opts: GenerateOptions): Promise<BenchQuery[]> {
  const minLen = opts.minLen ?? 20;
  const eligible = opts.leaves.filter((l) => l.text.trim().length >= minLen);
  const picked = sample(eligible, opts.count, opts.seed ?? 1);

  const out: BenchQuery[] = [];
  for (const leaf of picked) {
    const query = (await opts.infer(queryPrompt(leaf.text))).trim();
    if (query === "") continue;
    out.push({ query, relevant: new Set([leaf.id]) });
  }
  return out;
}
