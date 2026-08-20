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
