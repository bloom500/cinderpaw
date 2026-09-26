/**
 * Faza 1 — Async RSI Engine: single-field genome mutation (composition).
 *
 * `mutateConfig` selects one genome field uniformly and applies that
 * field's grammar-constrained operator, leaving the rest untouched. This
 * is the parametric mutation used to birth a child from a parent in
 * Faza 1 (no LLM-driven mutation yet).
 */

import { describe, expect, test } from "bun:test";
import { LIVE_REACH, type GenomeConfig } from "../src/rsi/l1-config/genome.ts";
import { MUTABLE_FIELDS, mutateConfig, type MutationGrammar } from "../src/rsi/l1-config/mutation.ts";

const PARENT: GenomeConfig = {
  promptTemplateId: 0,
  temperature: 0.7,
  systemPromptId: 0,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 1,
};

function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++] ?? 0;
}

function grammar(over: Partial<MutationGrammar> = {}): MutationGrammar {
  return {
    templatePoolSize: 5,
    systemPromptPoolSize: 5,
    maxTemperature: 1.0,
    temperatureSigma: 0.2,
    contextWindowSigma: 0.1,
    transferEpsilon: 0.1,
    rng: () => 0,
    gaussian: () => 0,
    ...over,
  };
}

describe("RSI mutateConfig", () => {
  test("mutates exactly one field, leaves the rest identical", () => {
    // MUTABLE_FIELDS is derived from LIVE_REACH: [temperature, systemPromptId].
    // Index 1 of 2 = systemPromptId: floor(0.72*2) = 1. Then resampleIndex
    // over the pool of 5 consumes one more value: floor(0.6*5) = 3.
    const g = grammar({ rng: seqRng([0.72, 0.6]) });
    const { child, field, mutationType } = mutateConfig(PARENT, g);

    expect(field).toBe("systemPromptId");
    expect(mutationType).toBe("parametric");
    expect(child.systemPromptId).toBe(3);

    // Every other field is untouched.
    expect(child.promptTemplateId).toBe(PARENT.promptTemplateId);
    expect(child.temperature).toBe(PARENT.temperature);
    expect(child.retrievalStrategy).toBe(PARENT.retrievalStrategy);
    expect(child.contextWindowUsage).toBe(PARENT.contextWindowUsage);
    expect(child.toolPreferenceWeights).toEqual(PARENT.toolPreferenceWeights);
    expect(child.decompositionDepth).toBe(PARENT.decompositionDepth);
    // Parent is not mutated in place.
    expect(PARENT.systemPromptId).toBe(0);
  });

  test("temperature mutation respects the provider ceiling", () => {
    // Index 0 of 2 = temperature: floor(0.2*2) = 0. Huge gaussian step.
    const g = grammar({ rng: seqRng([0.2]), gaussian: () => 100, maxTemperature: 1.0 });
    const { child, field } = mutateConfig(PARENT, g);
    expect(field).toBe("temperature");
    expect(child.temperature).toBe(1.0); // clamped to Anthropic ceiling
  });

  test("only the dimensions that reach the live agent are ever mutated", () => {
    // 13 Sep 2026: five of seven dimensions never reached the user, so eval
    // paid tokens to score noise. Whatever the rng draws, the child differs
    // from the parent only on a LIVE_REACH "applied" field.
    expect(MUTABLE_FIELDS).toEqual(["temperature", "systemPromptId"]);
    let x = 0.017;
    const rng = () => (x = (x * 9301 + 49297) % 233280) / 233280;
    for (let i = 0; i < 200; i++) {
      const { child, field } = mutateConfig(PARENT, grammar({ rng, gaussian: () => 0.5 }));
      expect(LIVE_REACH[field]).toBe("applied");
      for (const k of Object.keys(PARENT) as (keyof GenomeConfig)[]) {
        if (k !== field) expect(child[k]).toEqual(PARENT[k]);
      }
    }
  });

  test("a categorical mutation always changes the value (a clone is not a candidate)", () => {
    // The mutated field used to be resampled uniformly over the whole pool,
    // the parent's own value included: one systemPromptId draw in four, one
    // birth in eight, was the parent again. It cost a full eval, and a lucky
    // re-measurement of the SAME live agent could ratchet as an improvement
    // (the champion record then says `sameAppliedAsPrevious: true`).
    const parent = { ...PARENT, systemPromptId: 2 };
    let x = 0.31;
    const rng = () => (x = (x * 9301 + 49297) % 233280) / 233280;
    let categorical = 0;
    for (let i = 0; i < 400; i++) {
      const { child, field } = mutateConfig(parent, grammar({ rng }));
      if (field !== "systemPromptId") continue;
      categorical += 1;
      expect(child.systemPromptId).not.toBe(parent.systemPromptId);
      expect(child.systemPromptId).toBeGreaterThanOrEqual(0);
      expect(child.systemPromptId).toBeLessThan(5);
    }
    expect(categorical).toBeGreaterThan(50);
  });
});
