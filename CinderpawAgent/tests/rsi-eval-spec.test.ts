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

  test("a correct answer typed with Unicode is not marked wrong", () => {
    // Measured 2026-08-14: asked for the chemical formula of water, the model
    // answered "H₂O" with a subscript. The frozen Tier 0 spec expects "h2o", so
    // a right answer failed — and being Tier 0, that one flourish breached the
    // sanity floor and blocked every promotion on the machine.
    const water = spec({ kind: "fact_lookup", expected: { type: "fact_lookup", answer: "h2o" } });
    expect(validateOutcome(water, "H₂O", 50, 100)).toBe(true);
    expect(validateOutcome(water, "The formula is H₂O.", 50, 100)).toBe(true);
    // Fullwidth forms are the same story in another alphabet.
    const pi = spec({ kind: "fact_lookup", expected: { type: "fact_lookup", answer: "3.14" } });
    expect(validateOutcome(pi, "３.１４", 50, 100)).toBe(true);
  });

  test("folding does not make a wrong answer right", () => {
    // The guard on the guard: NFKC removes ways of writing the SAME answer, and
    // must never widen what counts as the answer.
    const water = spec({ kind: "fact_lookup", expected: { type: "fact_lookup", answer: "h2o" } });
    expect(validateOutcome(water, "H₃O", 50, 100)).toBe(false);
    expect(validateOutcome(water, "water", 50, 100)).toBe(false);
    expect(validateOutcome(water, "", 50, 100)).toBe(false);
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

  // Three of the thirteen Tier 0 tasks are json_format, and the recorded L4
  // report on this install (2026-07-09) shows all three failing for the
  // candidate AND the incumbent — the signature of a grader, not a model. A
  // fence the prompt asked the model not to use is still a correct answer.
  test("reads the object out of a code fence or out of prose", () => {
    expect(
      validateOutcome(s, '```json\n{"title":"t","summary":"s"}\n```', 50, 100),
    ).toBe(true);
    expect(
      validateOutcome(s, 'Here is the JSON:\n{"title":"t","summary":"s"}', 50, 100),
    ).toBe(true);
  });

  test("tolerating the wrapper does not tolerate a wrong answer", () => {
    // Key still missing — the fence buys nothing.
    expect(validateOutcome(s, '```json\n{"title":"t"}\n```', 50, 100)).toBe(false);
    // Prose that only talks about the keys, with no object in it.
    expect(validateOutcome(s, "The title and summary are both fine.", 50, 100)).toBe(false);
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
