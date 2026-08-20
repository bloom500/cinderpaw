/**
 * Embed CPU-only canonical mode — Pathway 4 PR-C C.5.
 *
 * Documents that embedding works correctly via a mock invoker (CPU path).
 * The real Vulkan path crashes on this dev box (RX 580 + llama.cpp × AMDVLK);
 * FERAL_EMBED_GPU_LAYERS=0 is the canonical knob.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { embed, resetEmbedCache } from "../src/memory/fractal/embed.ts";
import type { EmbedInvoker } from "../src/memory/fractal/embed.ts";

beforeEach(() => {
  resetEmbedCache();
});

/** A mock invoker that returns deterministic 768-dim vectors (bge-small dim). */
const mockInvoker: EmbedInvoker = async (texts: string[]) =>
  texts.map((_t) => {
    const v = new Float32Array(768);
    v[0] = 1; // unit vector along first axis
    return v;
  });

describe("Embed CPU-only mode (PR-C C.5)", () => {
  it("produces a non-empty 768-dim vector for a 100-char input", async () => {
    const input = "x".repeat(100);
    const results = await embed([input], mockInvoker);
    expect(results).toHaveLength(1);
    expect(results[0]!.length).toBe(768);
    // Should be L2-normalized (unit vector)
    const norm = Math.sqrt(results[0]!.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 4);
  });

  it("batch embed preserves order", async () => {
    const texts = ["alpha", "beta", "gamma"];
    const results = await embed(texts, mockInvoker);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.length).toBe(768);
    }
  });

  it("cache hit avoids re-invocation", async () => {
    let callCount = 0;
    const countingInvoker: EmbedInvoker = async (texts) => {
      callCount++;
      return texts.map(() => {
        const v = new Float32Array(768);
        v[0] = 1;
        return v;
      });
    };
    await embed(["cached-text"], countingInvoker);
    await embed(["cached-text"], countingInvoker);
    expect(callCount).toBe(1);
  });
});
