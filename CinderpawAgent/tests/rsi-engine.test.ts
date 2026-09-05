/**
 * Runtime wiring — the RSI engine composition root.
 *
 * `createRsiEngine` is the production composition root: it wires the
 * recorder + ratchet + selection + recalcitrance + extinction handlers
 * onto one bus, builds the EvalWorker and GoalMode, and seeds the
 * population. Everything is injected (eval runner, scorer, git ops, RNG),
 * so the WHOLE engine — including the Faza 2 extinction event — runs and
 * is asserted without a model.
 */

import { describe, expect, test } from "bun:test";
import { createRsiEngine } from "../src/rsi/engine.ts";
import { PopulationManager } from "../src/rsi/l1-config/population-manager.ts";
import type { GenomeConfig } from "../src/rsi/l1-config/genome.ts";
import type { RsiEvent } from "../src/rsi/infra/event-bus.ts";

const CFG: GenomeConfig = {
  promptTemplateId: 0,
  temperature: 0.7,
  systemPromptId: 0,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 1,
};

const BOUNDS = {
  templatePoolSize: 5,
  systemPromptPoolSize: 5,
  maxTemperature: 1.0,
  temperatureSigma: 0.2,
  contextWindowSigma: 0.1,
  transferEpsilon: 0.1,
};

function baseDeps(over: Record<string, unknown> = {}) {
  let gitBest = 0;
  let idN = 0;
  return {
    seeds: [{ id: "seed", generation: 0, lineage: [], config: CFG }],
    selection: {
      capacity: 8,
      bounds: BOUNDS,
      rng: () => 0,
      gaussian: () => 0,
      newId: () => `g${++idN}`,
    },
    ratchetDeps: {
      commitGenome: async () => ({ commitHash: "x".repeat(40) }),
      ratchetAttempt: async (_h: string, score: number) => {
        const previousBest = gitBest;
        const advanced = score > gitBest;
        if (advanced) gitBest = score;
        return { advanced, previousBest };
      },
    },
    ...over,
  };
}

describe("createRsiEngine", () => {
  test("composes the full engine and runs to a StopReason", async () => {
    let si = 0;
    const scores = [60, 75];
    const engine = createRsiEngine({
      ...baseDeps(),
      goal: { goal: "x", maxIterations: 10, maxTotalTokens: 1e9, targetScore: 70 },
      evalDeps: {
        runEval: async () => [
          { taskId: "t", tier: 0, success: true, latencyMs: 10, tokens: 100, errored: false },
        ],
        scoreGenome: async () => ({ score: scores[si++] ?? 75 }),
      },
    });
    const res = await engine.run();
    expect(res.reason).toBe("TargetReached");
    expect(res.best?.score).toBe(75);
  });

  test("a genome born here is visible to the population the commit adapter holds", async () => {
    // The bug this pins: the engine used to build its own PopulationManager.
    // Both were seeded from the same list, so the seeds existed in both and
    // committed fine, while every genome BORN by selection landed only in the
    // engine's copy. `commitGenome` looked children up in the caller's copy,
    // missed, and halted the episode with "unknown genome". On a live run that
    // was 4 seeds scored and 4 offspring halted, every episode — nothing but a
    // hand-written seed could ever reach the ratchet.
    //
    // The assertion is deliberately the production shape: a commit adapter
    // that resolves ids against the caller's population and throws on a miss,
    // exactly like makeCommitGenomeAdapter.
    const pop = new PopulationManager({ concurrency: 1 });
    const seeds = [{ id: "seed", generation: 0, lineage: [], config: CFG }];
    for (const seed of seeds) pop.add(seed);

    const missed: string[] = [];
    let gitBest = 0;
    let idN = 0;
    const engine = createRsiEngine({
      ...baseDeps({ seeds }),
      pop,
      selection: {
        capacity: 8,
        bounds: BOUNDS,
        rng: () => 0,
        gaussian: () => 0,
        newId: () => `child-${++idN}`,
      },
      goal: { goal: "x", maxIterations: 6, maxTotalTokens: 1e9 },
      evalDeps: {
        runEval: async () => [
          { taskId: "t", tier: 0, success: true, latencyMs: 10, tokens: 100, errored: false },
        ],
        scoreGenome: async () => ({ score: 50 + idN }),
      },
      ratchetDeps: {
        commitGenome: async (req: { genomeId: string }) => {
          if (!pop.get(req.genomeId)) missed.push(req.genomeId);
          return { commitHash: "x".repeat(40) };
        },
        ratchetAttempt: async (_h: string, score: number) => {
          const previousBest = gitBest;
          const advanced = score > gitBest;
          if (advanced) gitBest = score;
          return { advanced, previousBest, candidateScore: score, hadPrior: true };
        },
      },
    });

    await engine.run();

    // At least one child was actually born — otherwise this asserts nothing.
    expect(idN).toBeGreaterThan(0);
    expect(pop.get("child-1")).toBeDefined();
    expect(missed).toEqual([]);
  });

  test("the wired extinction handler fires on monoculture + plateau", async () => {
    const events: RsiEvent[] = [];
    // Six identical seeds → identical [1] fingerprints → similarity 1.
    const seeds = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`,
      generation: 0,
      lineage: [],
      config: CFG,
    }));
    const engine = createRsiEngine({
      ...baseDeps({ seeds }),
      goal: { goal: "x", maxIterations: 12, maxTotalTokens: 1e9 }, // no early plateau stop
      evalDeps: {
        runEval: async () => [
          { taskId: "t", tier: 0, success: true, latencyMs: 10, tokens: 100, errored: false },
        ],
        scoreGenome: async () => ({ score: 50 }), // flat → plateau
      },
      extinction: { monocultureThreshold: 0.85, plateauPatience: 2, periodicInterval: 1000 },
    });
    engine.bus.on("ExtinctionTriggered", (e) => void events.push(e));
    engine.bus.on("GenomeDied", (e) => void events.push(e));

    await engine.run();

    const triggered = events.filter((e) => e.type === "ExtinctionTriggered");
    expect(triggered.length).toBeGreaterThan(0);
    expect(triggered[0]!.reason).toBe("adaptive");
    expect(events.some((e) => e.type === "GenomeDied")).toBe(true);
  });
});
