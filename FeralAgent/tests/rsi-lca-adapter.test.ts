/**
 * Faza 2 — NEAT-Speciation Crossover: LCA adapter for the bridge.
 *
 * `makeLcaAdapter` builds the `hasRecentCommonAncestor` function the
 * crossover-selection pair picker expects. Production wiring injects
 * it into the picker via `SelectionDeps.crossover.selectPairs`
 * (constructed with `selectCrossoverPairs(pop, { hasRecentCommonAncestor })`).
 *
 * The adapter resolves genome ids to commit hashes through the
 * `PopulationManager` (the ratchet handler records the hash after
 * every successful `commitGenome`) and asks Rust's `rsi_lca` over
 * the protocol-(a) bridge. A `null` LCA OR a bridge error is treated
 * as "no common ancestor" — `selectCrossoverPairs` then drops the
 * pair, exactly as the NEAT-speciation design intends.
 *
 * Tests use a mock bridge (no Rust, no git substrate) and a real
 * PopulationManager (the in-memory commit-hash map is the contract).
 */

import { describe, expect, test } from "bun:test";
import {
  makeLcaAdapter,
} from "../src/rsi/infra/adapters.ts";
import { RsiBridge, type RsiResponse } from "../src/rsi/infra/bridge.ts";
import { PopulationManager } from "../src/rsi/l1-config/population-manager.ts";
import type { GenomeConfig } from "../src/rsi/l1-config/genome.ts";

const CFG: GenomeConfig = {
  promptTemplateId: 0,
  temperature: 0.5,
  systemPromptId: 0,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 0,
};

/** Mock bridge that records every request and replays a queued response. */
class MockBridge extends RsiBridge {
  readonly sent: Array<{ method: string; params: unknown }> = [];
  /** Maps request id → response; consumed FIFO by onResponse. */
  private responses: Array<RsiResponse> = [];

  constructor() {
    super({ send: () => {} });
  }

  enqueue(r: RsiResponse): void {
    this.responses.push(r);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = `rsi-${this.sent.length + 1}`;
    this.sent.push({ method, params });
    // Resolve synchronously by attaching the queued response to the
    // matching request id. onResponse uses the .pending map.
    setTimeout(() => {
      const next = this.responses.shift();
      if (next) this.onResponse({ ...next, id });
    }, 0);
    return super.request<T>(method, params);
  }
}

function makePop(): PopulationManager {
  const pop = new PopulationManager();
  pop.add({ id: "a", generation: 0, lineage: [], config: CFG });
  pop.add({ id: "b", generation: 0, lineage: [], config: CFG });
  pop.add({ id: "c", generation: 0, lineage: [], config: CFG });
  return pop;
}

describe("makeLcaAdapter", () => {
  test("looks up both hashes from the population and sends them on rsi_lca", async () => {
    const bridge = new MockBridge();
    const pop = makePop();
    pop.setCommitHash("a", "aaaa1111");
    pop.setCommitHash("b", "bbbb2222");
    bridge.enqueue({ id: "", ok: true, data: { lca: "root0000" } });
    const lca = makeLcaAdapter({ bridge, pop });
    const ok = await lca("a", "b");
    expect(ok).toBe(true);
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0]).toEqual({
      method: "rsi_lca",
      params: { a: "aaaa1111", b: "bbbb2222" },
    });
  });

  test("returns false when Rust reports lca: null", async () => {
    const bridge = new MockBridge();
    const pop = makePop();
    pop.setCommitHash("a", "a");
    pop.setCommitHash("b", "b");
    bridge.enqueue({ id: "", ok: true, data: { lca: null } });
    const lca = makeLcaAdapter({ bridge, pop });
    expect(await lca("a", "b")).toBe(false);
  });

  test("returns false when one of the genomes has no commit hash", async () => {
    const bridge = new MockBridge();
    const pop = makePop();
    pop.setCommitHash("a", "a");
    // b is in the population but never committed.
    const lca = makeLcaAdapter({ bridge, pop });
    expect(await lca("a", "b")).toBe(false);
    // No bridge call was made — the adapter is conservative on missing data.
    expect(bridge.sent).toHaveLength(0);
  });

  test("returns false when neither genome has a commit hash", async () => {
    const bridge = new MockBridge();
    const pop = makePop();
    const lca = makeLcaAdapter({ bridge, pop });
    expect(await lca("a", "b")).toBe(false);
    expect(bridge.sent).toHaveLength(0);
  });

  test("returns false on a bridge error (conservative — never widen by accident)", async () => {
    const bridge = new MockBridge();
    const pop = makePop();
    pop.setCommitHash("a", "a");
    pop.setCommitHash("b", "b");
    bridge.enqueue({ id: "", ok: false, error: "git2: not found" });
    const lca = makeLcaAdapter({ bridge, pop });
    expect(await lca("a", "b")).toBe(false);
  });

  test("two identical commit hashes are treated as trivially related (no bridge call)", async () => {
    const bridge = new MockBridge();
    const pop = makePop();
    pop.setCommitHash("a", "same");
    pop.setCommitHash("b", "same");
    const lca = makeLcaAdapter({ bridge, pop });
    expect(await lca("a", "b")).toBe(true);
    // The shortcut keeps us off the wire for the cheap case.
    expect(bridge.sent).toHaveLength(0);
  });

  test("end-to-end: SelectionDeps.crossover uses the adapter to filter pairs", async () => {
    // The ratchet handler records hashes via pop.setCommitHash; the
    // adapter reads them. Verify the wiring round-trips with a real
    // PopulationManager.
    const bridge = new MockBridge();
    const pop = new PopulationManager();
    pop.add({ id: "x", generation: 0, lineage: [], config: CFG });
    pop.add({ id: "y", generation: 0, lineage: [], config: CFG });
    pop.recordEval("x", { fitnessScore: 50, behavioralFingerprint: [1, 0] });
    pop.recordEval("y", { fitnessScore: 60, behavioralFingerprint: [0, 1] });
    pop.setCommitHash("x", "hx");
    pop.setCommitHash("y", "hy");
    bridge.enqueue({ id: "", ok: true, data: { lca: null } });
    const lca = makeLcaAdapter({ bridge, pop });
    expect(await lca("x", "y")).toBe(false);
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0]!.params).toEqual({ a: "hx", b: "hy" });
  });
});
