/**
 * Runtime wiring (Faza 2/3 into births) — the pure birth policy.
 *
 * `planBirth` decides how the next candidate is produced, composing the
 * Faza 2/3 operators that were built but not yet wired into reproduction:
 *   - crossover when a candidate pair is supplied (Faza 2);
 *   - otherwise a mutation under a grammar zoomed by the region's
 *     escape-time (Faza 3 fractal search), or the coarse grammar for a
 *     5% wild explorer;
 *   - then an optional taste-vector nudge (Faza 3 taste layer).
 * It is pure (deterministic given the injected RNG) so reproduction stays
 * replayable for PBT; the handler owns parent/pair selection and the
 * stochastic wild/zoom decisions and passes the resolved inputs in.
 */

import { describe, expect, test } from "bun:test";
import { planBirth } from "../src/rsi/birth-policy.ts";
import { crossoverConfigs } from "../src/rsi/crossover.ts";
import { applyTasteToConfig } from "../src/rsi/taste.ts";
import { mutateConfig, type MutationGrammar } from "../src/rsi/mutation.ts";
import { applyZoom } from "../src/rsi/fractal.ts";
import type { GenomeConfig } from "../src/rsi/genome.ts";
import type { Genome } from "../src/rsi/population-manager.ts";

const CFG: GenomeConfig = {
  promptTemplateId: 0,
  temperature: 0.5,
  systemPromptId: 0,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 1,
};

const genome = (id: string, generation: number, config: GenomeConfig): Genome => ({
  id,
  generation,
  lineage: [],
  config,
  mutationType: "seed",
  fitnessScore: 50,
  behavioralFingerprint: [1, 0],
  sharedFitness: 50,
  alive: true,
});

const base = (over: Partial<MutationGrammar> = {}): MutationGrammar => ({
  templatePoolSize: 5,
  systemPromptPoolSize: 5,
  maxTemperature: 1,
  temperatureSigma: 0.2,
  contextWindowSigma: 0.1,
  transferEpsilon: 0.1,
  rng: () => 0,
  gaussian: () => 0,
  ...over,
});

describe("planBirth", () => {
  test("default path: parametric mutation of the parent", () => {
    const parent = genome("p", 2, CFG);
    const plan = planBirth({ parent, base: base() });
    expect(plan.mutationType).toBe("parametric");
    expect(plan.lineage).toEqual(["p"]);
    expect(plan.generation).toBe(3);
    expect(plan.wild).toBe(false);
  });

  test("crossover path: child is the blend, lineage is both parents", () => {
    const fitter = genome("a", 4, { ...CFG, temperature: 0.8 });
    const other = genome("b", 2, { ...CFG, temperature: 0.4 });
    const plan = planBirth({
      parent: fitter,
      crossoverPair: { fitter, other },
      base: base(),
    });
    expect(plan.mutationType).toBe("crossover");
    expect(plan.lineage).toEqual(["a", "b"]);
    expect(plan.generation).toBe(5); // max(4,2)+1
    expect(plan.config).toEqual(crossoverConfigs(fitter.config!, other.config!));
  });

  test("wild explorer: flagged wild and labelled accordingly", () => {
    const parent = genome("p", 0, CFG);
    const plan = planBirth({ parent, base: base(), wild: true });
    expect(plan.wild).toBe(true);
    expect(plan.mutationType).toBe("wild");
  });

  test("zoom scales the mutation step (finer at factor < 1)", () => {
    // rng=0.15 selects the temperature field (index 1 of 7); gaussian=1
    // so the perturbation magnitude is exactly sigma*zoom.
    const g = base({ rng: () => 0.15, gaussian: () => 1 });
    const parent = genome("p", 0, CFG);
    const zoomed = planBirth({ parent, base: g, zoomFactor: 0.5 });
    const expected = mutateConfig(CFG, applyZoom(g, 0.5)).child;
    expect(zoomed.config.temperature).toBeCloseTo(expected.temperature, 12);
    // and it is finer than the unzoomed mutation
    const full = mutateConfig(CFG, g).child;
    expect(zoomed.config.temperature - CFG.temperature).toBeLessThan(
      full.temperature - CFG.temperature,
    );
  });

  test("taste nudge is applied on top of the produced child", () => {
    const fitter = genome("a", 1, { ...CFG, temperature: 0.8 });
    const other = genome("b", 1, { ...CFG, temperature: 0.4 });
    const taste = { vector: [0.2, 0, 0, 0, 0, 0, 0], weight: 0.5 };
    const plan = planBirth({
      parent: fitter,
      crossoverPair: { fitter, other },
      base: base(),
      taste,
    });
    const blended = crossoverConfigs(fitter.config!, other.config!);
    expect(plan.config).toEqual(
      applyTasteToConfig(blended, taste.vector, taste.weight, { maxTemperature: 1 }),
    );
  });
});
