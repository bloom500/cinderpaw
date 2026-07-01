/**
 * Evolution Budget — per-cycle, per-phase resource caps (BRSI §2.5).
 *
 * Contract under test:
 *   1. `assertCanSpend` returns allow=true when the projected total
 *      fits under the cap (cumulative resources) or peak (peak resources).
 *   2. `assertCanSpend` returns allow=false listing every breached
 *      resource; the reason names the breached resources.
 *   3. The fail-open contract: `null` estimate → allow=true with a
 *      reason that flags "no estimator, fail-open" so the journal can
 *      surface it.
 *   4. Partial estimate (some fields undefined) → only check the
 *      defined ones; the undefined ones are skipped.
 *   5. `applySpend` adds cumulative resources and peaks for CPU/RAM.
 *   6. `remaining` returns caps - spent, useful for UI burn-down.
 *   7. `DEFAULT_BUDGET_CAPS` matches BRSI §2.5 (locked).
 */
import { describe, expect, test } from "bun:test";
import {
  applySpend,
  assertCanSpend,
  DEFAULT_BUDGET_CAPS,
  type BudgetSpend,
  remaining,
  zeroSpend,
} from "../src/rsi/budget.ts";

describe("DEFAULT_BUDGET_CAPS — BRSI §2.5 alignment", () => {
  test("matches the spec's default cap table exactly", () => {
    expect(DEFAULT_BUDGET_CAPS).toEqual({
      wallClockMin: 30,
      cpuPct: 50,
      ramMb: 2_048,
      tokens: 100_000,
      energyKwh: 0.05,
      diskMb: 5_120,
    });
  });
});

describe("zeroSpend", () => {
  test("returns all-zero spend", () => {
    expect(zeroSpend()).toEqual({
      wallClockMin: 0,
      cpuPct: 0,
      ramMb: 0,
      tokens: 0,
      energyKwh: 0,
      diskMb: 0,
    });
  });
});

describe("assertCanSpend — happy path", () => {
  test("zero spend + zero estimate → allow", () => {
    const d = assertCanSpend(DEFAULT_BUDGET_CAPS, zeroSpend(), "evaluate", {});
    expect(d.allow).toBe(true);
    expect(d.breaches).toHaveLength(0);
    expect(d.reason).toMatch(/within budget/);
  });

  test("spend below cap + small estimate → allow", () => {
    const spent: BudgetSpend = { ...zeroSpend(), tokens: 50_000, wallClockMin: 10 };
    const d = assertCanSpend(DEFAULT_BUDGET_CAPS, spent, "evaluate", {
      tokens: 10_000,
      wallClockMin: 5,
    });
    expect(d.allow).toBe(true);
  });

  test("spend exactly at cap + zero estimate → allow", () => {
    const spent: BudgetSpend = { ...zeroSpend(), tokens: 100_000 };
    const d = assertCanSpend(DEFAULT_BUDGET_CAPS, spent, "remember", {});
    expect(d.allow).toBe(true);
  });
});

describe("assertCanSpend — breach detection", () => {
  test("single cumulative resource breach → reject with the resource named", () => {
    const spent: BudgetSpend = { ...zeroSpend(), tokens: 95_000 };
    const d = assertCanSpend(DEFAULT_BUDGET_CAPS, spent, "evaluate", {
      tokens: 10_000, // 95k + 10k = 105k > 100k cap
    });
    expect(d.allow).toBe(false);
    expect(d.breaches).toHaveLength(1);
    expect(d.breaches[0]!.resource).toBe("tokens");
    expect(d.breaches[0]!.cap).toBe(100_000);
    expect(d.breaches[0]!.spend).toBe(95_000);
    expect(d.breaches[0]!.estimate).toBe(10_000);
    expect(d.reason).toMatch(/breach.*on tokens/);
  });

  test("multiple breaches → all listed", () => {
    const spent: BudgetSpend = { ...zeroSpend(), tokens: 95_000, wallClockMin: 25 };
    const d = assertCanSpend(DEFAULT_BUDGET_CAPS, spent, "evaluate", {
      tokens: 10_000,
      wallClockMin: 10,
      cpuPct: 60, // would peak at 60 > 50 cap
    });
    expect(d.allow).toBe(false);
    expect(d.breaches.map((b) => b.resource).sort()).toEqual([
      "cpuPct",
      "tokens",
      "wallClockMin",
    ]);
  });

  test("exact cap + smallest positive estimate → reject", () => {
    const spent: BudgetSpend = { ...zeroSpend(), tokens: 100_000 };
    const d = assertCanSpend(DEFAULT_BUDGET_CAPS, spent, "evaluate", {
      tokens: 1,
    });
    expect(d.allow).toBe(false);
    expect(d.breaches).toHaveLength(1);
  });
});

describe("assertCanSpend — partial estimate", () => {
  test("undefined fields are skipped, defined fields are checked", () => {
    const spent: BudgetSpend = { ...zeroSpend(), tokens: 99_000 };
    // Estimate only mentions wallClockMin — tokens is NOT checked.
    const d = assertCanSpend(DEFAULT_BUDGET_CAPS, spent, "evaluate", {
      wallClockMin: 5,
    });
    expect(d.allow).toBe(true); // tokens at 99k < 100k cap; wallClock within cap
  });

  test("empty object estimate (all undefined) → allow with no breaches", () => {
    const spent: BudgetSpend = { ...zeroSpend(), tokens: 999_999 };
    const d = assertCanSpend(DEFAULT_BUDGET_CAPS, spent, "evaluate", {});
    expect(d.allow).toBe(true);
    expect(d.breaches).toHaveLength(0);
  });
});

describe("assertCanSpend — fail-open contract", () => {
  test("null estimate → allow=true with explicit reason", () => {
    const d = assertCanSpend(DEFAULT_BUDGET_CAPS, zeroSpend(), "dream", null);
    expect(d.allow).toBe(true);
    expect(d.reason).toMatch(/no estimator.*fail-open/);
    expect(d.breaches).toHaveLength(0);
  });

  test("null estimate + already over cap → still allow (fail-open is intentional)", () => {
    const spent: BudgetSpend = { ...zeroSpend(), tokens: 200_000 }; // over cap
    const d = assertCanSpend(DEFAULT_BUDGET_CAPS, spent, "evaluate", null);
    expect(d.allow).toBe(true);
    // The fail-open caveat reason is the operator's signal that they
    // should wire an estimator for this phase.
    expect(d.reason).toMatch(/fail-open/);
  });
});

describe("applySpend — peak vs cumulative semantics", () => {
  test("cumulative resources sum across phases", () => {
    const a: BudgetSpend = { ...zeroSpend(), tokens: 1000, wallClockMin: 5, diskMb: 100 };
    const b: BudgetSpend = { ...zeroSpend(), tokens: 2000, wallClockMin: 3, diskMb: 50 };
    const result = applySpend(a, b);
    expect(result.tokens).toBe(3000);
    expect(result.wallClockMin).toBe(8);
    expect(result.diskMb).toBe(150);
  });

  test("peak resources take the max across phases", () => {
    const a: BudgetSpend = { ...zeroSpend(), cpuPct: 30, ramMb: 1000 };
    const b: BudgetSpend = { ...zeroSpend(), cpuPct: 60, ramMb: 800 };
    const result = applySpend(a, b);
    expect(result.cpuPct).toBe(60); // peak, not sum
    expect(result.ramMb).toBe(1000); // peak of 1000 vs 800
  });

  test("peak resources: lower second phase doesn't lower the running peak", () => {
    const a: BudgetSpend = { ...zeroSpend(), cpuPct: 70, ramMb: 1500 };
    const b: BudgetSpend = { ...zeroSpend(), cpuPct: 20, ramMb: 500 };
    const result = applySpend(a, b);
    expect(result.cpuPct).toBe(70);
    expect(result.ramMb).toBe(1500);
  });

  test("does not mutate either argument", () => {
    const a: BudgetSpend = { ...zeroSpend(), tokens: 100 };
    const b: BudgetSpend = { ...zeroSpend(), tokens: 200 };
    const before = JSON.parse(JSON.stringify({ a, b })) as { a: BudgetSpend; b: BudgetSpend };
    applySpend(a, b);
    expect(a).toEqual(before.a);
    expect(b).toEqual(before.b);
  });

  test("identity: applying zeroSpend leaves spend unchanged", () => {
    const a: BudgetSpend = { ...zeroSpend(), tokens: 500, cpuPct: 25 };
    expect(applySpend(a, zeroSpend())).toEqual(a);
  });
});

describe("remaining", () => {
  test("returns caps - spent for every resource", () => {
    const spent: BudgetSpend = {
      ...zeroSpend(),
      wallClockMin: 10,
      cpuPct: 20,
      ramMb: 1024,
      tokens: 25_000,
      energyKwh: 0.01,
      diskMb: 1024,
    };
    const r = remaining(DEFAULT_BUDGET_CAPS, spent);
    expect(r).toEqual({
      wallClockMin: 20,
      cpuPct: 30,
      ramMb: 1024,
      tokens: 75_000,
      energyKwh: 0.04,
      diskMb: 4096,
    });
  });

  test("all-spent → all zeros", () => {
    expect(remaining(DEFAULT_BUDGET_CAPS, DEFAULT_BUDGET_CAPS)).toEqual(zeroSpend());
  });

  test("over-spent → negative values (informational, gate catches via assertCanSpend)", () => {
    const overspent: BudgetSpend = { ...zeroSpend(), tokens: 200_000 };
    const r = remaining(DEFAULT_BUDGET_CAPS, overspent);
    expect(r.tokens).toBe(-100_000);
  });
});

describe("assertCanSpend + applySpend — end-to-end cycle", () => {
  test("a realistic 4-phase cycle that exhausts tokens exactly at the cap", () => {
    let spent = zeroSpend();
    const caps = DEFAULT_BUDGET_CAPS;

    // Phase 1: observe — 5k tokens
    let d = assertCanSpend(caps, spent, "observe", { tokens: 5_000 });
    expect(d.allow).toBe(true);
    spent = applySpend(spent, { ...zeroSpend(), tokens: 5_000 });

    // Phase 2: dream — 30k tokens
    d = assertCanSpend(caps, spent, "dream", { tokens: 30_000 });
    expect(d.allow).toBe(true);
    spent = applySpend(spent, { ...zeroSpend(), tokens: 30_000 });

    // Phase 3: evaluate — 80k tokens would breach: 5+30+80 = 115k > 100k cap.
    d = assertCanSpend(caps, spent, "evaluate", { tokens: 80_000 });
    expect(d.allow).toBe(false);
    expect(d.breaches[0]!.resource).toBe("tokens");

    // The estimator / contract trims the estimate to 60k to fit.
    d = assertCanSpend(caps, spent, "evaluate", { tokens: 60_000 });
    expect(d.allow).toBe(true);
    spent = applySpend(spent, { ...zeroSpend(), tokens: 60_000 });

    // Phase 4: remember — exactly 5k tokens remaining.
    d = assertCanSpend(caps, spent, "remember", { tokens: 5_000 });
    expect(d.allow).toBe(true);
    spent = applySpend(spent, { ...zeroSpend(), tokens: 5_000 });

    expect(spent.tokens).toBe(100_000); // exact cap, no overflow
  });

  test("a multi-resource scenario: tokens + wall-clock both matter", () => {
    let spent: BudgetSpend = { ...zeroSpend(), tokens: 90_000, wallClockMin: 25 };
    const caps = DEFAULT_BUDGET_CAPS;

    // 15k tokens would breach (90+15 = 105 > 100).
    let d = assertCanSpend(caps, spent, "evaluate", { tokens: 15_000 });
    expect(d.allow).toBe(false);
    expect(d.breaches.map((b) => b.resource).sort()).toEqual(["tokens"]);

    // 11k tokens + 6 min wall: 90+11=101 > 100 AND 25+6=31 > 30. Both breach.
    d = assertCanSpend(caps, spent, "evaluate", { tokens: 11_000, wallClockMin: 6 });
    expect(d.allow).toBe(false);
    expect(d.breaches.map((b) => b.resource).sort()).toEqual(["tokens", "wallClockMin"]);

    // 8k tokens + 4 min: 90+8 = 98 < 100, 25+4 = 29 < 30. Both fit.
    d = assertCanSpend(caps, spent, "evaluate", { tokens: 8_000, wallClockMin: 4 });
    expect(d.allow).toBe(true);
  });
});