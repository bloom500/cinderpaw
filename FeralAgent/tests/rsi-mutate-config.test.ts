/**
 * Faza 1 — Async RSI Engine: single-field genome mutation (composition).
 *
 * `mutateConfig` selects one genome field uniformly and applies that
 * field's grammar-constrained operator, leaving the rest untouched. This
 * is the parametric mutation used to birth a child from a parent in
 * Faza 1 (no LLM-driven mutation yet).
 */

import { describe, expect, test } from "bun:test";
import { RETRIEVAL_STRATEGIES, type GenomeConfig } from "../src/rsi/l1-config/genome.ts";
import { mutateConfig, type MutationGrammar } from "../src/rsi/l1-config/mutation.ts";

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
    // Field index 5 of 7 = toolPreferenceWeights: floor(0.72*7) = 5.
    // Then transferMutation consumes two rng values (donor 0, recipient 1).
    const g = grammar({ rng: seqRng([0.72, 0.0, 0.3]) });
    const { child, field, mutationType } = mutateConfig(PARENT, g);

    expect(field).toBe("toolPreferenceWeights");
    expect(mutationType).toBe("parametric");
    expect(child.toolPreferenceWeights).toEqual([0.15, 0.35, 0.25, 0.25]);
    expect(child.toolPreferenceWeights.reduce((a, b) => a + b, 0)).toBeCloseTo(1);

    // Every other field is untouched.
    expect(child.promptTemplateId).toBe(PARENT.promptTemplateId);
    expect(child.temperature).toBe(PARENT.temperature);
    expect(child.systemPromptId).toBe(PARENT.systemPromptId);
    expect(child.retrievalStrategy).toBe(PARENT.retrievalStrategy);
    expect(child.contextWindowUsage).toBe(PARENT.contextWindowUsage);
    expect(child.decompositionDepth).toBe(PARENT.decompositionDepth);
    // Parent is not mutated in place.
    expect(PARENT.toolPreferenceWeights).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  test("temperature mutation respects the provider ceiling", () => {
    // Field index 1 = temperature: floor(0.2*7) = 1. Huge gaussian step.
    const g = grammar({ rng: seqRng([0.2]), gaussian: () => 100, maxTemperature: 1.0 });
    const { child, field } = mutateConfig(PARENT, g);
    expect(field).toBe("temperature");
    expect(child.temperature).toBe(1.0); // clamped to Anthropic ceiling
  });

  test("retrieval strategy mutation yields a valid enum member", () => {
    // Field index 3 = retrievalStrategy: floor(0.45*7) = 3. Resample idx 2 = "graph".
    const g = grammar({ rng: seqRng([0.45, 0.5]) });
    const { child, field } = mutateConfig(PARENT, g);
    expect(field).toBe("retrievalStrategy");
    expect(RETRIEVAL_STRATEGIES).toContain(child.retrievalStrategy);
    expect(child.retrievalStrategy).toBe("graph");
  });
});
