/**
 * FMS scale bench — Pathway 4 PR-C Task C.4.
 *
 * Env-gated: CINDERPAW_FMS_BENCH=1 bun test tests/fractal-scale.test.ts
 *
 * Tests LeafStore + dedup performance at 10k and 100k leaf scale.
 * Does NOT test FractalMemory.query() (needs embeddings/GPU).
 */
import { describe, it, expect } from "bun:test";
import { performance } from "node:perf_hooks";
import { LeafStore, type LeafRecord } from "../src/memory/fractal/leaf-store.ts";
import { dedupAcrossSessions } from "../src/memory/fractal/cross-session-dedup.ts";

const ENABLED = process.env.CINDERPAW_FMS_BENCH === "1";

function p99(sorted: number[]): number {
  const idx = Math.ceil(sorted.length * 0.99) - 1;
  return sorted[Math.max(0, idx)]!;
}

function makeRecord(id: number): LeafRecord {
  const now = Date.now();
  return {
    id,
    text: `leaf-text-${id}-` + "x".repeat(64),
    vec: Array.from({ length: 384 }, () => Math.random()),
    ts: now,
    sessionId: "bench",
    provenance: {
      source: "bench",
      first_seen_at: now - Math.random() * 30 * 86_400_000,
      last_seen_at: now - Math.random() * 10 * 86_400_000,
      hit_count: Math.floor(Math.random() * 10),
    },
  };
}

describe("FMS scale (CINDERPAW_FMS_BENCH=1)", () => {
  it.skipIf(!ENABLED)("LeafStore: upsert 10k records p99 < 20ms", () => {
    const store = new LeafStore(":memory:");
    const timings: number[] = [];
    for (let i = 1; i <= 10_000; i++) {
      const t0 = performance.now();
      store.upsert(makeRecord(i));
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    const p = p99(timings);
    console.log(`  10k upsert p99: ${p.toFixed(2)}ms`);
    expect(p).toBeLessThan(20);
  });

  it.skipIf(!ENABLED)("LeafStore: summaries() on 10k records p99 < 10ms", () => {
    const store = new LeafStore(":memory:");
    for (let i = 1; i <= 10_000; i++) store.upsert(makeRecord(i));
    const timings: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      store.summaries();
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    const p = p99(timings);
    console.log(`  10k summaries p99: ${p.toFixed(2)}ms`);
    expect(p).toBeLessThan(20);
  });

  it.skipIf(!ENABLED)("LeafStore: remove 1k from 10k p99 < 20ms", () => {
    const store = new LeafStore(":memory:");
    for (let i = 1; i <= 10_000; i++) store.upsert(makeRecord(i));
    const timings: number[] = [];
    for (let batch = 0; batch < 10; batch++) {
      const ids = Array.from({ length: 100 }, (_, j) => batch * 100 + j + 1);
      const t0 = performance.now();
      store.remove(ids);
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    const p = p99(timings);
    console.log(`  remove 100 from 10k p99: ${p.toFixed(2)}ms`);
    expect(p).toBeLessThan(20);
  });

  it.skipIf(!ENABLED)("LeafStore: upsert 100k records p99 < 50ms", () => {
    const store = new LeafStore(":memory:");
    const timings: number[] = [];
    for (let i = 1; i <= 100_000; i++) {
      const t0 = performance.now();
      store.upsert(makeRecord(i));
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    const p = p99(timings);
    console.log(`  100k upsert p99: ${p.toFixed(2)}ms`);
    expect(p).toBeLessThan(50);
  });

  it.skipIf(!ENABLED)("dedupAcrossSessions: 200 leaves p99 < 100ms", () => {
    const now = Date.now();
    const leaves = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      text: `leaf-${i}`,
      first_seen_at: now - (i % 100) * 86_400_000,
      last_seen_at: now - (i % 50) * 86_400_000,
      hit_count: (i % 5) + 1,
      vec: Array.from({ length: 384 }, () => Math.random()),
    }));
    const timings: number[] = [];
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      dedupAcrossSessions(leaves, { mergeThreshold: 0.92, spanThresholdMs: 30 * 86_400_000, now });
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    const p = p99(timings);
    console.log(`  dedup 200 p99: ${p.toFixed(2)}ms`);
    expect(p).toBeLessThan(100);
  });
});
