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
import { validateOutcome, type EvalExpected, type EvalSpec } from "../src/rsi/infra/eval-spec.ts";
import { toolSuccessFromOutcomes } from "../src/rsi/l1-config/fitness.ts";

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

describe("tool_call validator", () => {
  const spec = (over: Partial<Extract<EvalExpected, { type: "tool_call" }>> = {}): EvalSpec => ({
    id: "t/tool",
    tier: 2,
    name: "t",
    description: "t",
    prompt: "p",
    kind: "tool_call",
    expected: { type: "tool_call", tool: "web_search", required_args: ["query"], ...over },
  });

  test("passes on a bare JSON call with the right tool and args", () => {
    const r = '{"tool": "web_search", "args": {"query": "bun release"}}';
    expect(validateOutcome(spec(), r, 10, 10)).toBe(true);
  });

  test("passes with prose around and inside a ```json fence", () => {
    const fenced = 'Sure! Here is the call:\n```json\n{"tool": "web_search", "args": {"query": "x"}}\n```';
    expect(validateOutcome(spec(), fenced, 10, 10)).toBe(true);
  });

  test("fails on wrong tool, missing required arg, or non-JSON", () => {
    expect(validateOutcome(spec(), '{"tool": "calculator", "args": {"query": "x"}}', 10, 10)).toBe(false);
    expect(validateOutcome(spec(), '{"tool": "web_search", "args": {}}', 10, 10)).toBe(false);
    expect(validateOutcome(spec(), "I would use web_search for this.", 10, 10)).toBe(false);
  });

  test("arg_equals pins values case-insensitively", () => {
    const pinned = spec({
      tool: "http_request",
      required_args: ["url", "method"],
      arg_equals: { method: "get" },
    });
    expect(validateOutcome(pinned, '{"tool":"http_request","args":{"url":"https://x","method":"GET"}}', 10, 10)).toBe(true);
    expect(validateOutcome(pinned, '{"tool":"http_request","args":{"url":"https://x","method":"POST"}}', 10, 10)).toBe(false);
  });

  test("toolSuccessFromOutcomes: pass rate over tool tasks only, null without them", () => {
    expect(toolSuccessFromOutcomes([])).toBeNull();
    expect(toolSuccessFromOutcomes([{ kind: "fact_lookup", success: true }])).toBeNull();
    expect(
      toolSuccessFromOutcomes([
        { kind: "tool_call", success: true },
        { kind: "tool_call", success: false },
        { kind: "fact_lookup", success: false },
      ]),
    ).toBeCloseTo(0.5, 6);
  });
});
