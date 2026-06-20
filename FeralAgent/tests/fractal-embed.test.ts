/**
 * Module A — embed bridge (TDD).
 *
 * Verifies the four contract guarantees: batching (one bridge call per
 * `embed(...)` invocation, regardless of input length), order preservation
 * (result[i] ↔ texts[i]), cache hit on repeat (no second bridge call for
 * identical text), and dedup within a single call (a batch with duplicates
 * sends one vector per unique text).
 *
 * All tests inject a fake invoker — we never hit Rust here.
 */
import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  embed,
  resetEmbedCache,
  type EmbedInvoker,
} from "../src/memory/fractal/embed.ts";

/** Helper: a fake invoker that counts calls and returns stable fake vectors. */
function fakeInvoker(
  impl: (texts: string[]) => Float32Array[],
): EmbedInvoker & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = ((texts: string[]) => {
    calls.push([...texts]);
    return Promise.resolve(impl(texts));
  }) as EmbedInvoker & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

/** Helper: a deterministic 2D unit vector derived from a text's first char code. */
function vecFromText(text: string): Float32Array {
  const c = text.charCodeAt(0) || 1;
  const angle = (c % 360) * (Math.PI / 180);
  return new Float32Array([Math.cos(angle), Math.sin(angle)]);
}

describe("embed — batching", () => {
  beforeEach(() => resetEmbedCache());

  it("calls the invoker exactly once with the full input batch", async () => {
    const inv = fakeInvoker((t) => t.map(vecFromText));
    await embed(["a", "b", "c", "d"], inv);
    expect(inv.calls).toHaveLength(1);
    expect(inv.calls[0]).toEqual(["a", "b", "c", "d"]);
  });

  it("handles a single-text batch (one call, one vector back)", async () => {
    const inv = fakeInvoker((t) => t.map(vecFromText));
    const out = await embed(["only"], inv);
    expect(inv.calls).toEqual([["only"]]);
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(2);
  });

  it("handles an empty batch without invoking the bridge", async () => {
    const inv = fakeInvoker((t) => t.map(vecFromText));
    const out = await embed([], inv);
    expect(out).toEqual([]);
    expect(inv.calls).toEqual([]);
  });
});

describe("embed — order preservation", () => {
  beforeEach(() => resetEmbedCache());

  it("result[i] is the embedding of texts[i] (same text in different positions = same vec)", async () => {
    const inv = fakeInvoker((t) => t.map(vecFromText));
    const out = await embed(["x", "y", "x"], inv);
    expect(out).toHaveLength(3);
    // Position 0 and 2 are the same text → same vector.
    expect(Array.from(out[0]!)).toEqual(Array.from(out[2]!));
    // Position 1 is a different text → a different vector.
    expect(Array.from(out[1]!)).not.toEqual(Array.from(out[0]!));
  });
});

describe("embed — caching", () => {
  beforeEach(() => resetEmbedCache());

  it("repeat call with identical text does NOT invoke the bridge again", async () => {
    const inv = fakeInvoker((t) => t.map(vecFromText));
    await embed(["hello"], inv);
    await embed(["hello"], inv);
    expect(inv.calls).toEqual([["hello"]]);
  });

  it("cache is partial: only the missing texts go to the bridge on a second call", async () => {
    const inv = fakeInvoker((t) => t.map(vecFromText));
    await embed(["a", "b"], inv);
    await embed(["b", "c"], inv);
    expect(inv.calls).toEqual([["a", "b"], ["c"]]);
  });

  it("dedups within a single batch: duplicates sent to the bridge only once", async () => {
    const inv = fakeInvoker((t) => t.map(vecFromText));
    await embed(["x", "x", "x", "y"], inv);
    expect(inv.calls).toEqual([["x", "y"]]);
    // And order is preserved in the returned vectors.
    const out = await embed(["x", "x", "x", "y"], inv);
    expect(out).toHaveLength(4);
    expect(Array.from(out[0]!)).toEqual(Array.from(out[1]!));
    expect(Array.from(out[1]!)).toEqual(Array.from(out[2]!));
  });
});

describe("embed — normalization", () => {
  beforeEach(() => resetEmbedCache());

  it("L2-normalizes the invoker's output (defense in depth — Rust already does it)", async () => {
    // Invoker returns a clearly non-unit vector; embed should fix it.
    const inv: EmbedInvoker = async () => [
      new Float32Array([3, 4]), // 3-4-5 triangle → length 5
    ];
    const out = await embed(["anything"], inv);
    const v = out[0]!;
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
  });
});

describe("embed — error handling", () => {
  beforeEach(() => resetEmbedCache());

  it("throws if no invoker is set and none is passed", async () => {
    // No invoker anywhere; we deliberately don't call setEmbedInvoker in this test.
    // (The module-level default is null between test runs unless a prior test set it.)
    await expect(embed(["x"])).rejects.toThrow(/no invoker/i);
  });

  it("throws when the invoker returns a length-mismatched batch", async () => {
    const inv: EmbedInvoker = async () => [new Float32Array([1, 0])]; // 1 vec, 2 texts
    await expect(embed(["a", "b"], inv)).rejects.toThrow(/length mismatch/i);
  });
});
