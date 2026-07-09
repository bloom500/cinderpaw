/**
 * Faza 1 — runEval real: the sidecar-side deterministic validator.
 *
 * `validateOutcome` is the TS mirror of Rust's `tier0::validate_outcome`.
 * It computes the per-task pass/fail that becomes `EvalOutcome.success`.
 * It is intentionally deterministic (no LLM-as-judge) so that an eval run
 * is reproducible — a hard requirement for Population-Based Training,
 * which compares genomes by replaying the same suite.
 *
 * Scoring (the composite 0..100) stays in Rust (`rsi_score`); the sidecar
 * only ever decides binary per-task success. This keeps the
 * asymmetric-trust boundary intact: the agent can edit the prompts/specs
 * it runs, but not the formula that grades the whole batch.
 */

import { describe, expect, test } from "bun:test";
import { validateOutcome, type EvalSpec } from "../src/rsi/infra/eval-spec.ts";

const spec = (over: Partial<EvalSpec>): EvalSpec => ({
  id: "t/x",
  tier: 1,
  name: "x",
  description: "x",
  prompt: "x",
  kind: "fact_lookup",
  expected: { type: "fact_lookup", answer: "paris" },
  ...over,
});

describe("validateOutcome — fact_lookup", () => {
  const s = spec({
    kind: "fact_lookup",
    expected: { type: "fact_lookup", answer: "paris" },
  });

  test("matches case- and whitespace-insensitively", () => {
    expect(validateOutcome(s, "The answer is Paris.", 50, 100)).toBe(true);
    expect(validateOutcome(s, "PARIS", 50, 100)).toBe(true);
  });

  test("rejects a wrong answer", () => {
    expect(validateOutcome(s, "London", 50, 100)).toBe(false);
  });

  test("rejects empty response", () => {
    expect(validateOutcome(s, "", 50, 100)).toBe(false);
  });
});

describe("validateOutcome — json_format", () => {
  const s = spec({
    kind: "json_format",
    expected: { type: "json_format", required_keys: ["title", "summary"] },
  });

  test("accepts a JSON object with all required keys", () => {
    expect(
      validateOutcome(s, '{"title":"t","summary":"s"}', 50, 100),
    ).toBe(true);
  });

  test("rejects a JSON object missing a required key", () => {
    expect(validateOutcome(s, '{"title":"t"}', 50, 100)).toBe(false);
  });

  test("rejects non-JSON and non-objects", () => {
    expect(validateOutcome(s, "not json", 50, 100)).toBe(false);
    expect(validateOutcome(s, "[1,2,3]", 50, 100)).toBe(false);
  });
});

describe("validateOutcome — token_budget / latency are upper bounds", () => {
  test("token_budget passes at the bound, fails one over", () => {
    const s = spec({
      kind: "token_budget",
      expected: { type: "token_budget", max_tokens: 800 },
    });
    expect(validateOutcome(s, "anything", 800, 100)).toBe(true);
    expect(validateOutcome(s, "anything", 801, 100)).toBe(false);
  });

  test("latency passes at the bound, fails one over", () => {
    const s = spec({
      kind: "latency",
      expected: { type: "latency", max_ms: 1500 },
    });
    expect(validateOutcome(s, "anything", 50, 1500)).toBe(true);
    expect(validateOutcome(s, "anything", 50, 1501)).toBe(false);
  });
});

describe("validateOutcome — defends against kind/expected mismatch", () => {
  test("returns false when the discriminators disagree", () => {
    const s = spec({
      kind: "fact_lookup",
      expected: { type: "latency", max_ms: 100 },
    });
    expect(validateOutcome(s, "anything", 50, 50)).toBe(false);
  });
});
