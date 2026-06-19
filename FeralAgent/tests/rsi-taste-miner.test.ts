/**
 * Faza 3 — Taste Layer: production miner handler.
 *
 * `TasteMiner` subscribes to `RatchetAdvanced`, fetches the last N
 * main commits via `rsi_log`, pairs each with its predecessor, runs
 * `mineTasteVector`, and persists the result to
 * `~/.feral/meta/pbt_state.json`. Exposes `getVector` / `getWeight`
 * for the SelectionDeps.taste binding.
 *
 * Tests cover the core contract with a mock bridge (no Rust, no
 * filesystem, no model):
 *   - on RatchetAdvanced the miner queries rsi_log and updates state;
 *   - the persisted file shape matches `PbtState`;
 *   - `makeTasteDeps(miner)` produces the SelectionDeps.taste shape;
 *   - a missing snapshot in `rsi_log` is silently skipped, not crashed;
 *   - bridge errors do NOT propagate (taste is a soft bias);
 *   - loadPersisted restores state across "restarts" (in-memory seam);
 *   - concurrent RatchetAdvanced events coalesce into one mine chain.
 */

import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/rsi/event-bus.ts";
import { RsiBridge } from "../src/rsi/bridge.ts";
import { PopulationManager } from "../src/rsi/population-manager.ts";
import {
  TasteMiner,
  makeTasteDeps,
  type CommitMetaWire,
  type PbtState,
} from "../src/rsi/taste-miner.ts";
import type { GenomeConfig } from "../src/rsi/genome.ts";

const CFG_BASE: GenomeConfig = {
  promptTemplateId: 0,
  temperature: 0.3,
  systemPromptId: 0,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 0,
};

/** Mock bridge that records calls and lets a test enqueue responses. */
class MockBridge extends RsiBridge {
  readonly sent: Array<{ method: string; params: unknown }> = [];
  /** FIFO queue of rsi_log responses (newest first). */
  logResponses: CommitMetaWire[][] = [];

  constructor() {
    super({ send: () => {} });
  }

  enqueueLog(items: CommitMetaWire[]): void {
    this.logResponses.push(items);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = `rsi-${this.sent.length + 1}`;
    this.sent.push({ method, params });
    if (method === "rsi_log") {
      const next = this.logResponses.shift() ?? [];
      setTimeout(() => this.onResponse({ id, ok: true, data: next }), 0);
      return super.request<T>(method, params);
    }
    throw new Error(`MockBridge: unexpected method '${method}'`);
  }
}

function makePop(): PopulationManager {
  return new PopulationManager();
}

describe("TasteMiner — wiring", () => {
  test("on RatchetAdvanced the miner queries rsi_log with the configured window", async () => {
    const bus = new EventBus();
    const bridge = new MockBridge();
    const pop = makePop();
    bridge.enqueueLog([]);
    const miner = new TasteMiner(bus, { bridge, pop, fsRoot: "/tmp/x", historyWindow: 12 });
    await bus.emit({
      type: "RatchetAdvanced",
      genomeId: "g1",
      commitHash: "h1",
      score: 50,
      previousBest: 40,
      tokenCost: 100,
    });
    await miner.drain();
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0]).toEqual({ method: "rsi_log", params: { max: 12 } });
  });

  test("pairs consecutive commits (newer wins) and runs the taste miner over them", async () => {
    const bus = new EventBus();
    const bridge = new MockBridge();
    const pop = makePop();
    // Two commits on main: newest is "warm" (hotter temp + heavier ctx),
    // older is "cool" (cold temp + lighter ctx). Expected direction:
    // +temperature, +contextWindowUsage, others ~0.
    pop.setCommitConfig("h-new", { ...CFG_BASE, temperature: 0.7, contextWindowUsage: 0.8 });
    pop.setCommitConfig("h-old", { ...CFG_BASE, temperature: 0.3, contextWindowUsage: 0.4 });
    bridge.enqueueLog([
      { commit_hash: "h-new", parent_hashes: ["h-old"], author: "x", timestamp: 2, summary: "", metadata_json: null },
      { commit_hash: "h-old", parent_hashes: ["h-root"], author: "x", timestamp: 1, summary: "", metadata_json: null },
    ]);
    const miner = new TasteMiner(bus, { bridge, pop, fsRoot: "/tmp/x" });
    await bus.emit({
      type: "RatchetAdvanced",
      genomeId: "g",
      commitHash: "h-new",
      score: 60,
      previousBest: 50,
      tokenCost: 100,
    });
    await miner.drain();

    const v = miner.getVector();
    expect(v[0]).toBeCloseTo(0.4, 5); // (0.7 - 0.3) = 0.4 (temperature)
    expect(v[1]).toBeCloseTo(0.4, 5); // (0.8 - 0.4) = 0.4 (contextWindowUsage)
    expect(miner.getHistoryDepth()).toBe(1);
  });

  test("missing snapshots are silently skipped (no crash)", async () => {
    const bus = new EventBus();
    const bridge = new MockBridge();
    const pop = makePop();
    pop.setCommitConfig("h-new", { ...CFG_BASE, temperature: 0.7 });
    // h-old is NOT in pop → pair is dropped, mine returns the zero vector.
    bridge.enqueueLog([
      { commit_hash: "h-new", parent_hashes: ["h-old"], author: "x", timestamp: 2, summary: "", metadata_json: null },
      { commit_hash: "h-old", parent_hashes: [], author: "x", timestamp: 1, summary: "", metadata_json: null },
    ]);
    const miner = new TasteMiner(bus, { bridge, pop, fsRoot: "/tmp/x" });
    await bus.emit({
      type: "RatchetAdvanced",
      genomeId: "g",
      commitHash: "h-new",
      score: 60,
      previousBest: 50,
      tokenCost: 100,
    });
    await miner.drain();
    expect(miner.getHistoryDepth()).toBe(0);
    expect(miner.getVector().every((x) => x === 0)).toBe(true);
  });

  test("a bridge error does NOT crash the bus or propagate", async () => {
    const bus = new EventBus();
    const bridge = new MockBridge();
    const pop = makePop();
    // Simulate a Rust error: enqueue an error response.
    bridge.enqueueLog([]); // not used — we inject error below
    const miner = new TasteMiner(bus, { bridge, pop, fsRoot: "/tmp/x" });
    // Override request to throw on rsi_log
    bridge.request = async () => {
      throw new Error("bridge dropped");
    };
    // Should not throw — taste is a soft bias.
    await bus.emit({
      type: "RatchetAdvanced",
      genomeId: "g",
      commitHash: "h",
      score: 60,
      previousBest: 50,
      tokenCost: 100,
    });
    await miner.drain();
    // Vector remains zero (default), weight 0 (no history).
    expect(miner.getVector().every((x) => x === 0)).toBe(true);
    expect(miner.getWeight()).toBe(0);
  });

  test("consecutive RatchetAdvanced events coalesce into a chain", async () => {
    const bus = new EventBus();
    const bridge = new MockBridge();
    const pop = makePop();
    pop.setCommitConfig("h1", { ...CFG_BASE, temperature: 0.3 });
    pop.setCommitConfig("h2", { ...CFG_BASE, temperature: 0.5 });
    pop.setCommitConfig("h3", { ...CFG_BASE, temperature: 0.7 });
    // First event sees 3 commits → 2 pairs:
    //   (h3 - h2) = 0.2, (h2 - h1) = 0.2 → avg = 0.2
    bridge.enqueueLog([
      { commit_hash: "h3", parent_hashes: ["h2"], author: "x", timestamp: 3, summary: "", metadata_json: null },
      { commit_hash: "h2", parent_hashes: ["h1"], author: "x", timestamp: 2, summary: "", metadata_json: null },
      { commit_hash: "h1", parent_hashes: [], author: "x", timestamp: 1, summary: "", metadata_json: null },
    ]);
    // Second event sees 2 commits → 1 pair:
    //   (h2 - h1) = 0.2 → avg = 0.2 (overwrites the first)
    bridge.enqueueLog([
      { commit_hash: "h2", parent_hashes: ["h1"], author: "x", timestamp: 2, summary: "", metadata_json: null },
      { commit_hash: "h1", parent_hashes: [], author: "x", timestamp: 1, summary: "", metadata_json: null },
    ]);
    const miner = new TasteMiner(bus, { bridge, pop, fsRoot: "/tmp/x" });

    // Fire 2 events back-to-back; the second mine should run AFTER
    // the first completes (chained on `mining`).
    await bus.emit({ type: "RatchetAdvanced", genomeId: "g1", commitHash: "h3", score: 70, previousBest: 60, tokenCost: 1 });
    await bus.emit({ type: "RatchetAdvanced", genomeId: "g2", commitHash: "h2", score: 60, previousBest: 50, tokenCost: 1 });
    await miner.drain();

    expect(bridge.sent.length).toBeGreaterThanOrEqual(2);
    // Last mine = (h2 - h1) = 0.2
    expect(miner.getVector()[0]).toBeCloseTo(0.2, 5);
  });
});

describe("TasteMiner — persistence", () => {
  test("after a successful mine, pbt_state.json is written with the expected shape", async () => {
    const bus = new EventBus();
    const bridge = new MockBridge();
    const pop = makePop();
    pop.setCommitConfig("h2", { ...CFG_BASE, temperature: 0.7 });
    pop.setCommitConfig("h1", { ...CFG_BASE, temperature: 0.3 });
    bridge.enqueueLog([
      { commit_hash: "h2", parent_hashes: ["h1"], author: "x", timestamp: 2, summary: "", metadata_json: null },
      { commit_hash: "h1", parent_hashes: [], author: "x", timestamp: 1, summary: "", metadata_json: null },
    ]);
    const writes: Array<{ path: string; data: unknown }> = [];
    const miner = new TasteMiner(bus, {
      bridge,
      pop,
      fsRoot: "/fake/root",
      writeJson: async (path, data) => {
        writes.push({ path, data });
      },
      now: () => 12345,
    });
    await bus.emit({ type: "RatchetAdvanced", genomeId: "g", commitHash: "h2", score: 60, previousBest: 50, tokenCost: 1 });
    await miner.drain();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/fake/root/pbt_state.json");
    const state = writes[0]!.data as PbtState;
    expect(state.taste_vector[0]).toBeCloseTo(0.4, 5);
    expect(state.history_depth).toBe(1);
    expect(state.last_mined_at).toBe(12345);
  });

  test("loadPersisted seeds in-memory state from a previous file", async () => {
    const bus = new EventBus();
    const bridge = new MockBridge();
    const pop = makePop();
    const miner = new TasteMiner(bus, {
      bridge,
      pop,
      fsRoot: "/fake",
      readJson: async () => ({
        taste_vector: [0.1, 0.2, 0.3, 0, 0, 0, 0],
        history_depth: 7,
        population_size: 12,
        last_mined_at: 999,
      }),
    });
    await miner.loadPersisted();
    expect(miner.getVector()).toEqual([0.1, 0.2, 0.3, 0, 0, 0, 0]);
    expect(miner.getHistoryDepth()).toBe(7);
  });

  test("loadPersisted ignores a missing or malformed file (no-op)", async () => {
    const bus = new EventBus();
    const bridge = new MockBridge();
    const pop = makePop();
    const miner = new TasteMiner(bus, {
      bridge,
      pop,
      fsRoot: "/fake",
      readJson: async () => {
        throw new Error("ENOENT");
      },
    });
    await miner.loadPersisted();
    expect(miner.getVector().every((x) => x === 0)).toBe(true);
    expect(miner.getHistoryDepth()).toBe(0);
  });

  test("loadPersisted rejects a taste_vector with the wrong arity", async () => {
    const bus = new EventBus();
    const bridge = new MockBridge();
    const pop = makePop();
    const miner = new TasteMiner(bus, {
      bridge,
      pop,
      fsRoot: "/fake",
      readJson: async () => ({
        taste_vector: [0.1, 0.2], // too short
        history_depth: 7,
        population_size: 12,
        last_mined_at: 999,
      }),
    });
    await miner.loadPersisted();
    // Malformed → defaults (zero vector), history stays 0.
    expect(miner.getVector().every((x) => x === 0)).toBe(true);
    expect(miner.getHistoryDepth()).toBe(0);
  });
});

describe("makeTasteDeps — SelectionDeps.taste binding", () => {
  test("exposes vector() and weight() bound to the miner", async () => {
    const bus = new EventBus();
    const bridge = new MockBridge();
    const pop = new PopulationManager();
    pop.add({ id: "seed", generation: 0, lineage: [], config: CFG_BASE });
    pop.recordEval("seed", { fitnessScore: 30, behavioralFingerprint: [1] });
    pop.setCommitConfig("h2", { ...CFG_BASE, temperature: 0.7 });
    pop.setCommitConfig("h1", { ...CFG_BASE, temperature: 0.3 });
    bridge.enqueueLog([
      { commit_hash: "h2", parent_hashes: ["h1"], author: "x", timestamp: 2, summary: "", metadata_json: null },
      { commit_hash: "h1", parent_hashes: [], author: "x", timestamp: 1, summary: "", metadata_json: null },
    ]);
    const miner = new TasteMiner(bus, { bridge, pop, fsRoot: "/fake" });
    await bus.emit({ type: "RatchetAdvanced", genomeId: "seed", commitHash: "h2", score: 60, previousBest: 30, tokenCost: 1 });
    await miner.drain();
    const taste = makeTasteDeps(miner);
    expect(taste.vector()).toEqual(miner.getVector());
    expect(taste.weight()).toBeGreaterThan(0);
    expect(taste.weight()).toBeLessThanOrEqual(0.5); // maxWeight default
  });

  test("before any mine, weight() is 0 (no history)", () => {
    const bus = new EventBus();
    const bridge = new MockBridge();
    const pop = makePop();
    const miner = new TasteMiner(bus, { bridge, pop, fsRoot: "/fake" });
    const taste = makeTasteDeps(miner);
    expect(taste.weight()).toBe(0);
  });
});
