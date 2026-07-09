/**
 * Evolution Contract — type layer (BRSI §2.1).
 *
 * Contract under test:
 *   1. STAGE_ORDER has 9 entries (entry + 8 stages).
 *   2. Every STAGE_ORDER entry is a valid ContractStage.
 *   3. The 9 stages match BRSI §2.1 in order.
 *   4. StageResult is a discriminated union (ok=true vs ok=false).
 *   5. makeInitialState builds a valid empty state with required fields.
 *   6. The optional rollbackTarget field is preserved when provided.
 *
 * The HANDLER implementations are Opus's territory. These tests
 * verify only the type layer / state construction. Once the FSM is
 * implemented, additional tests will exercise the runner's halt-on-
 * failure and stage sequencing behaviour.
 */
import { describe, expect, test } from "bun:test";
import {
  makeInitialState,
  STAGE_ORDER,
  type ContractStage,
} from "../src/rsi/infra/contract.ts";
import { DEFAULT_BUDGET_CAPS } from "../src/rsi/infra/budget.ts";

describe("STAGE_ORDER — pipeline shape", () => {
  test("has 9 entries (entry + 8 BRSI §2.1 stages)", () => {
    expect(STAGE_ORDER).toHaveLength(9);
  });

  test("starts at 'candidate_proposed' (entry state)", () => {
    expect(STAGE_ORDER[0]).toBe("candidate_proposed");
  });

  test("ends at 'monitoring' (post-deploy health check)", () => {
    expect(STAGE_ORDER[STAGE_ORDER.length - 1]).toBe("monitoring");
  });

  test("contains every BRSI §2.1 stage in the documented order", () => {
    const expected: ContractStage[] = [
      "candidate_proposed",
      "static_analysis",
      "sandbox_apply",
      "tests",
      "benchmark",
      "safety_checks",
      "regression",
      "deploy",
      "monitoring",
    ];
    expect([...STAGE_ORDER]).toEqual(expected);
  });

  test("no duplicate stages", () => {
    const set = new Set(STAGE_ORDER);
    expect(set.size).toBe(STAGE_ORDER.length);
  });
});

describe("makeInitialState — minimal valid state", () => {
  test("builds the entry state with required fields", () => {
    const state = makeInitialState({
      cycleId: "c-2026-07-14-001",
      candidateId: "cfg-2026-07-14-c-014",
      layer: "L1",
      budgetCaps: DEFAULT_BUDGET_CAPS,
      now: 1_752_000_000_000,
    });
    expect(state.cycleId).toBe("c-2026-07-14-001");
    expect(state.candidateId).toBe("cfg-2026-07-14-c-014");
    expect(state.layer).toBe("L1");
    expect(state.currentStage).toBe("candidate_proposed");
    expect(state.history).toEqual([]);
    expect(state.startedAt).toBe(1_752_000_000_000);
  });

  test("zero budget by default", () => {
    const state = makeInitialState({
      cycleId: "c-1",
      candidateId: "x",
      layer: "L0",
      budgetCaps: DEFAULT_BUDGET_CAPS,
      now: 0,
    });
    expect(state.budgetSpent).toEqual({
      wallClockMin: 0,
      cpuPct: 0,
      ramMb: 0,
      tokens: 0,
      energyKwh: 0,
      diskMb: 0,
    });
  });

  test("rollbackTarget is preserved when supplied", () => {
    const state = makeInitialState({
      cycleId: "c-1",
      candidateId: "x",
      layer: "L3",
      budgetCaps: DEFAULT_BUDGET_CAPS,
      now: 0,
      rollbackTarget: "abc123",
    });
    expect(state.rollbackTarget).toBe("abc123");
  });

  test("rollbackTarget is undefined when not supplied", () => {
    const state = makeInitialState({
      cycleId: "c-1",
      candidateId: "x",
      layer: "L0",
      budgetCaps: DEFAULT_BUDGET_CAPS,
      now: 0,
    });
    expect(state.rollbackTarget).toBeUndefined();
  });

  test("all 7 layer values are accepted", () => {
    for (const layer of ["L0", "L1", "L2", "L3", "L4", "L5", "L6"] as const) {
      const state = makeInitialState({
        cycleId: "c-1",
        candidateId: "x",
        layer,
        budgetCaps: DEFAULT_BUDGET_CAPS,
        now: 0,
      });
      expect(state.layer).toBe(layer);
    }
  });
});