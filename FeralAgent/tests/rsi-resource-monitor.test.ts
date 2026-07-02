/**
 * Faza 4 Slice 5 — resource monitor: real (not notional) numbers, and the
 * loraStats dashboard aggregation.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loraStats, type LoraReviewCard } from "../src/rsi/lora-pipeline.ts";
import type { LoraAdapterRecord } from "../src/rsi/lora-registry.ts";
import {
  dirSizeMb,
  endResourceSample,
  startResourceSample,
} from "../src/rsi/resource-monitor.ts";

describe("resource sampling", () => {
  test("measures real cpu/ram/wall over a window", () => {
    let t = 1_000;
    const sample = startResourceSample(() => t);
    // Burn CPU for a measurable slice of the (fake) 6s window — long
    // enough that cpuPct survives the one-decimal rounding.
    let x = 0;
    for (let i = 0; i < 20_000_000; i++) x += Math.sqrt(i);
    expect(x).toBeGreaterThan(0);
    t = 7_000; // six (fake) seconds later
    const usage = endResourceSample(sample, () => t);
    expect(usage.cpuPct).toBeGreaterThan(0);
    expect(usage.ramMb).toBeGreaterThan(1); // a Bun process is bigger than 1MB
    expect(usage.wallClockMin).toBe(0.1);
  });
});

describe("dirSizeMb", () => {
  test("sums a real tree; missing dir → 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "res-mon-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "a.bin"), Buffer.alloc(512 * 1024));
    writeFileSync(join(dir, "sub", "b.bin"), Buffer.alloc(512 * 1024));
    expect(dirSizeMb(dir)).toBe(1);
    expect(dirSizeMb(join(dir, "nope"))).toBe(0);
  });
});

describe("loraStats", () => {
  const rec = (over: Partial<LoraAdapterRecord>): LoraAdapterRecord => ({
    id: "a",
    domain: "general",
    adapterPath: "a.gguf",
    baseModel: "base.gguf",
    status: "candidate",
    createdAt: 0,
    provenance: { datasetId: "d", datasetHash: "h", hyperparameters: {}, metrics: {} },
    ...over,
  });
  const card = (over: Partial<LoraReviewCard>): LoraReviewCard => ({
    adapterId: "a",
    domain: "general",
    gate: { verdict: "recommend_promote", reason: "", humanApprovalRequired: true },
    metrics: {},
    status: "pending",
    createdAt: 0,
    ...over,
  });

  test("empty inputs → zeros and nulls", () => {
    expect(loraStats([], [])).toEqual({
      adapters: 0,
      datasets: 0,
      pendingReviews: 0,
      champions: 0,
      rollbacks: 0,
      acceptanceRate: null,
      averageGain: null,
      trainingMsTotal: 0,
    });
  });

  test("aggregates statuses, datasets, gains and training time", () => {
    const bootstrap = { mean: 0.4, ciLower: 0.1, ciUpper: 0.7, pValue: 0.01, effectSize: 0.9 };
    const stats = loraStats(
      [
        rec({ id: "a", status: "champion", provenance: { datasetId: "d1", datasetHash: "h1", hyperparameters: {}, metrics: { training_ms: 60_000 } } }),
        rec({ id: "b", status: "rolled_back", provenance: { datasetId: "d1", datasetHash: "h1", hyperparameters: {}, metrics: { training_ms: 30_000 } } }),
        rec({ id: "c", status: "retired", provenance: { datasetId: "d2", datasetHash: "h2", hyperparameters: {}, metrics: {} } }),
      ],
      [
        card({ adapterId: "a", status: "approved", gate: { verdict: "recommend_promote", reason: "", humanApprovalRequired: true, confidence: { accept: true, reason: "", bootstrap } } }),
        card({ adapterId: "c", status: "rejected", gate: { verdict: "reject", reason: "", humanApprovalRequired: true, confidence: { accept: false, reason: "", bootstrap: { ...bootstrap, mean: 0 } } } }),
        card({ adapterId: "x", status: "pending" }),
      ],
    );
    expect(stats.adapters).toBe(3);
    expect(stats.datasets).toBe(2);
    expect(stats.pendingReviews).toBe(1);
    expect(stats.champions).toBe(1);
    expect(stats.rollbacks).toBe(1);
    expect(stats.acceptanceRate).toBe(0.5);
    expect(stats.averageGain).toBe(0.2); // mean of 0.4 and 0
    expect(stats.trainingMsTotal).toBe(90_000);
  });
});
