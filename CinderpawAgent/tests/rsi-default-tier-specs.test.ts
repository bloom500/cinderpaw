/**
 * Faza 1 — runEval real: the embedded Tier 1/2 default suite.
 *
 * Tier 1/2 specs ship embedded (not as loose JSON) because bun
 * `--compile` does not bundle data files; users can still extend them by
 * dropping JSON in `~/.cinderpaw/eval/tierN`. These tests guard the embedded
 * set's integrity: well-formed, unique ids, correct tier, and — most
 * importantly — *satisfiable* (a synthesized correct answer passes the
 * spec's own validator, so no spec is impossible to pass).
 */

import { describe, expect, test } from "bun:test";
import { TIER1_SPECS, TIER2_SPECS } from "../src/rsi/infra/default-tier-specs.ts";
import { validateOutcome, type EvalSpec } from "../src/rsi/infra/eval-spec.ts";

/** A response that should pass `spec` — derived from its expected payload. */
function passingResponse(spec: EvalSpec): string {
  switch (spec.expected.type) {
    case "fact_lookup":
      return spec.expected.answer;
    case "json_format":
      return JSON.stringify(
        Object.fromEntries(spec.expected.required_keys.map((k) => [k, "x"])),
      );
    case "token_budget":
    case "latency":
      return "ok";
  }
}

describe.each([
  ["Tier 1", TIER1_SPECS, 1],
  ["Tier 2", TIER2_SPECS, 2],
])("%s default specs", (_label, specs, tier) => {
  test("is non-empty", () => {
    expect(specs.length).toBeGreaterThan(0);
  });

  test("every spec has the right tier and a non-empty prompt", () => {
    for (const s of specs) {
      expect(s.tier).toBe(tier);
      expect(s.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  test("ids are unique and tier-prefixed", () => {
    const ids = specs.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.startsWith(`tier${tier}/`)).toBe(true);
  });

  test("every spec is satisfiable by a synthesized correct answer", () => {
    for (const s of specs) {
      // generous token/latency so non-budget kinds aren't tripped
      expect(validateOutcome(s, passingResponse(s), 10, 10)).toBe(true);
    }
  });
});

test("Tier 1 and Tier 2 ids do not collide", () => {
  const all = [...TIER1_SPECS, ...TIER2_SPECS].map((s) => s.id);
  expect(new Set(all).size).toBe(all.length);
});
