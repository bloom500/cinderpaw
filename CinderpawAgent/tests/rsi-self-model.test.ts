/**
 * The self-model: the agent's predictions about its own improvement loop,
 * checked against what the contract then decided. Three things must hold or
 * "metacognition" is a word: an over-confident agent is caught by the
 * numbers, the selector moves experiments away from settled places, and the
 * loop can say "nothing left to learn here" before the budget says it.
 */
import { describe, expect, test } from "bun:test";
import {
  MIN_ROUNDS_FOR_ESTIMATE,
  buildSelfModel,
  experimentValue,
  nothingLeftToLearn,
} from "../src/rsi/l3-code/self-model.ts";
import {
  selectExperiment,
  type Attempt,
  type FailureClass,
} from "../src/rsi/l3-code/experiment-selector.ts";

let clock = 0;
const round = (
  file: string,
  pAccept: number,
  accepted: boolean,
  over: { effect?: number; failureClass?: FailureClass | null } = {},
): Attempt => ({
  file,
  rationale: "r",
  verdict: accepted ? "accept" : "reject",
  reason: accepted ? "ok" : "suite failed",
  ts: ++clock,
  predicted: { pAccept, expectedEffect: 1, expectedCost: 1000, failureClass: null, missing: null },
  observed: {
    accepted,
    effect: accepted ? (over.effect ?? 1) : null,
    cost: 1000,
    failureClass: accepted ? null : (over.failureClass ?? "wrong_proposal"),
  },
});

describe("calibration", () => {
  test("an agent that says 0.9 and gets refused every time has a Brier score near 0.81", () => {
    const rows = Array.from({ length: 10 }, () => round("a.ts", 0.9, false));
    const m = buildSelfModel(rows);
    expect(m.overall.predictedAccept).toBeCloseTo(0.9);
    expect(m.overall.observedAccept).toBe(0);
    expect(m.overall.brier).toBeCloseTo(0.81);
  });

  test("an agent whose 0.3 comes true 3 times in 10 scores far better", () => {
    const rows = Array.from({ length: 10 }, (_, i) => round("a.ts", 0.3, i < 3));
    const m = buildSelfModel(rows);
    expect(m.overall.brier!).toBeLessThan(0.25);
  });

  test("the dominant failure is counted from the runner's classification, per file", () => {
    const rows = [
      round("a.ts", 0.5, false, { failureClass: "wrong_file" }),
      round("a.ts", 0.5, false, { failureClass: "wrong_file" }),
      round("a.ts", 0.5, false, { failureClass: "unmeasured" }),
      round("b.ts", 0.5, false, { failureClass: "unmeasured" }),
    ];
    const m = buildSelfModel(rows);
    expect(m.files.get("a.ts")?.dominantFailure).toBe("wrong_file");
    expect(m.files.get("b.ts")?.dominantFailure).toBe("unmeasured");
  });

  test("rows written before predictions existed still count toward the accept rate, not the Brier", () => {
    const legacy: Attempt = { file: "a.ts", rationale: "r", verdict: "accept", reason: "ok", ts: ++clock };
    const m = buildSelfModel([legacy, round("a.ts", 0.5, false)]);
    const a = m.files.get("a.ts")!;
    expect(a.observedAccept).toBe(0.5);
    expect(a.n).toBe(1);
  });
});

describe("where an experiment is worth it", () => {
  test("a never-tried file is worth more than a settled dead end and less than a proven vein", () => {
    const rows = [
      ...Array.from({ length: 5 }, () => round("dead.ts", 0.2, false)),
      ...Array.from({ length: 5 }, (_, i) => round("vein.ts", 0.5, i % 2 === 0, { effect: 2 })),
    ];
    const m = buildSelfModel(rows);
    expect(experimentValue(m, "dead.ts")).toBe(0);
    expect(experimentValue(m, "fresh.ts")).toBe(0.5);
    // vein.ts: accepted 3 of 5 → uncertainty 4·0.6·0.4 = 0.96, effect 2.
    expect(experimentValue(m, "vein.ts")).toBeCloseTo(1.92);
  });

  test("the selector moves the budget away from a file it has stopped learning from", () => {
    const files = ["dead.ts", "vein.ts"];
    const rows = [
      // Two refusals: still under MAX_STRIKES, so dead.ts is not struck out;
      // it is just known to be a dead end.
      round("dead.ts", 0.6, false),
      round("dead.ts", 0.6, false),
      round("dead.ts", 0.6, true, { effect: 0 }),
      ...Array.from({ length: 3 }, (_, i) => round("vein.ts", 0.5, i % 2 === 0, { effect: 3 })),
    ];
    // dead.ts: 1 of 3 accepted, effect 0 → value 0. vein.ts: 2 of 3, effect 3 → 0.89·3.
    expect(selectExperiment(files, rows, () => 0)?.target).toBe("vein.ts");
  });
});

describe("knowing when to stop", () => {
  test("says no while any file is under-sampled or still uncertain", () => {
    const rows = Array.from({ length: MIN_ROUNDS_FOR_ESTIMATE }, () => round("a.ts", 0.5, false));
    const m = buildSelfModel(rows);
    expect(nothingLeftToLearn(m, ["a.ts", "b.ts"])).toBe(false); // b.ts never tried
    const half = buildSelfModel(Array.from({ length: 6 }, (_, i) => round("c.ts", 0.5, i % 2 === 0)));
    expect(nothingLeftToLearn(half, ["c.ts"])).toBe(false); // 50/50 is maximal uncertainty
  });

  test("says yes when every file in the pool is a settled result", () => {
    const rows = [
      ...Array.from({ length: 4 }, () => round("dead.ts", 0.1, false)),
      ...Array.from({ length: 4 }, () => round("done.ts", 0.9, true, { effect: 0 })),
    ];
    expect(nothingLeftToLearn(buildSelfModel(rows), ["dead.ts", "done.ts"])).toBe(true);
  });
});
