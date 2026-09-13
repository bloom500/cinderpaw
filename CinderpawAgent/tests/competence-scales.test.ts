/**
 * Competence scales (plan §3.2, first slice): a strategy is a step verified
 * across conditions, it carries its counterexamples from the start, and a
 * new counterexample narrows it to exactly the condition it came from.
 */
import { describe, expect, test } from "bun:test";
import { buildPrinciples, buildScales, narrow, narrowPrinciple } from "../src/memory/fractal/competence-scales.ts";
import { induceProcedure, type LearnedProcedure } from "../src/memory/fractal/skill-library.ts";
import type { Attempt } from "../src/rsi/l3-code/experiment-selector.ts";

let clock = 0;
const r = (tool: string, condition: string, ok: boolean): Attempt => ({
  file: tool,
  rationale: condition,
  condition,
  verdict: ok ? "accept" : "reject",
  reason: ok ? "verified" : "verifier failed",
  ts: ++clock,
  observed: { accepted: ok, effect: ok ? 1 : null, cost: 1, failureClass: null },
});

const proc = (tool: string, condition: string): LearnedProcedure => {
  const out = induceProcedure({
    train: [r(tool, condition, true)],
    heldOut: [r(tool, condition, true)],
    verifiedBy: "v",
    methodVersion: "m",
  });
  if (!out.skill) throw new Error("fixture");
  return out.skill;
};

describe("buildScales", () => {
  test("one step verified across two conditions is a strategy; across one it is only a procedure", () => {
    const procs = [proc("fix-import-paths", "sig-a"), proc("fix-import-paths", "sig-b"), proc("bump-engine", "sig-c")];
    const scales = buildScales([], procs);
    expect(scales.procedures).toHaveLength(3);
    expect(scales.strategies.map((s) => s.step)).toEqual(["fix-import-paths"]);
    expect(scales.strategies[0]!.covers).toEqual(["sig-a", "sig-b"]);
  });

  test("a strategy is born knowing its counterexamples", () => {
    const procs = [proc("fix-import-paths", "sig-a"), proc("fix-import-paths", "sig-b")];
    const receipts = [r("fix-import-paths", "sig-a", true), r("fix-import-paths", "sig-b", false), r("bump-engine", "sig-a", false)];
    const s = buildScales(receipts, procs).strategies[0]!;
    expect(s.support.for).toEqual([`fix-import-paths@${receipts[0]!.ts}`]);
    expect(s.support.against).toEqual([`fix-import-paths@${receipts[1]!.ts}`]);
  });
});

describe("narrow", () => {
  const procs = [proc("fix-import-paths", "sig-a"), proc("fix-import-paths", "sig-b")];

  test("a counterexample removes exactly its condition and names the procedure to retire", () => {
    const s = buildScales([], procs).strategies[0]!;
    const counter = r("fix-import-paths", "sig-b", false);
    const out = narrow(s, counter, 123);
    expect(out.changed).toBe(true);
    expect(out.strategy.covers).toEqual(["sig-a"]);
    expect(out.strategy.support.against).toEqual([`fix-import-paths@${counter.ts}`]);
    expect(out.strategy.narrowed).toEqual([{ condition: "sig-b", byReceipt: `fix-import-paths@${counter.ts}`, at: 123 }]);
    expect(out.retireProcedureFor).toBe("sig-b");
    expect(out.strategy.retired).toBeUndefined();
    // The original is untouched: history is a new value, not a mutation.
    expect(s.covers).toEqual(["sig-a", "sig-b"]);
  });

  test("the last counterexample retires the strategy with its history, never deletes it", () => {
    let s = buildScales([], procs).strategies[0]!;
    s = narrow(s, r("fix-import-paths", "sig-a", false)).strategy;
    s = narrow(s, r("fix-import-paths", "sig-b", false)).strategy;
    expect(s.covers).toEqual([]);
    expect(s.retired?.reason).toContain("every covered condition was contradicted");
    expect(s.narrowed).toHaveLength(2);
  });

  test("an accept, another step, or an uncovered condition is not a counterexample", () => {
    const s = buildScales([], procs).strategies[0]!;
    expect(narrow(s, r("fix-import-paths", "sig-a", true)).changed).toBe(false);
    expect(narrow(s, r("bump-engine", "sig-a", false)).changed).toBe(false);
    expect(narrow(s, r("fix-import-paths", "sig-z", false)).changed).toBe(false);
  });
});

describe("the principle scale (structural): prefer A over B on the conditions it was observed", () => {
  test("A verified and B refused on a condition is a preference; both verified, or only one tried, is not", () => {
    const receipts = [
      r("fix-import-paths", "sig-a", true), r("bump-engine", "sig-a", false),   // preference on sig-a
      r("fix-import-paths", "sig-b", true), r("bump-engine", "sig-b", true),    // both work: no preference
      r("fix-import-paths", "sig-c", true),                                     // B untried: no claim
    ];
    const ps = buildPrinciples(receipts);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ prefer: "fix-import-paths", over: "bump-engine", on: ["sig-a"] });
    expect(ps[0]!.support.for).toHaveLength(2);
  });

  test("a mixed condition (A both verified and refused there) is not a preference", () => {
    const receipts = [r("a", "sig", true), r("a", "sig", false), r("b", "sig", false)];
    expect(buildPrinciples(receipts)).toHaveLength(0);
  });

  test("a counterexample narrows the principle on its condition only; the strategy below is narrowed independently", () => {
    const receipts = [
      r("fix-import-paths", "sig-a", true), r("bump-engine", "sig-a", false),
      r("fix-import-paths", "sig-b", true), r("bump-engine", "sig-b", false),
    ];
    const p = buildPrinciples(receipts)[0]!;
    expect(p.on).toEqual(["sig-a", "sig-b"]);
    const strategy = buildScales(receipts, [proc("fix-import-paths", "sig-a"), proc("fix-import-paths", "sig-b")]).strategies[0]!;

    // A refusal of the preferred step on a condition the principle never
    // claimed: the strategy does not cover it either; nothing moves.
    const elsewhere = r("fix-import-paths", "sig-z", false);
    expect(narrowPrinciple(p, elsewhere).changed).toBe(false);
    expect(narrow(strategy, elsewhere).changed).toBe(false);

    // The other step verifying on sig-b contradicts the preference there,
    // and says nothing about whether fix-import-paths still works on sig-b.
    const bWorks = r("bump-engine", "sig-b", true);
    const np = narrowPrinciple(p, bWorks);
    expect(np.changed).toBe(true);
    expect(np.principle.on).toEqual(["sig-a"]);
    expect(np.principle.support.against).toEqual([`bump-engine@${bWorks.ts}`]);
    expect(narrow(strategy, bWorks).changed).toBe(false);

    // The preferred step refused on sig-a contradicts both scales there.
    const aFails = r("fix-import-paths", "sig-a", false);
    const np2 = narrowPrinciple(np.principle, aFails);
    expect(np2.principle.retired).toBeDefined();
    expect(np2.principle.narrowed.map((n) => n.condition)).toEqual(["sig-b", "sig-a"]);
    expect(narrow(strategy, aFails).strategy.covers).toEqual(["sig-b"]);
  });
});
