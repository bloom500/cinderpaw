/**
 * Evolution Contract stage handlers (BRSI §2.1) — leaf behaviour.
 *
 * Contract under test (the HANDLER leaves — not the runner):
 *   For every stage except `benchmark`:
 *     - success: dep.ok:true → {ok:true, stage, durationMs >= 0}
 *     - failure (dep.ok:false / dep.regressed / dep.advanced:false):
 *                  → {ok:false, halt:false, recoverable:true}  (soft)
 *     - dep threw: → {ok:false, halt:true,  recoverable:false} (hard / infra)
 *   For `benchmark`: artifact carries {fitnessVector, aggregate, samples}.
 *   For `sandbox_apply`: artifact carries {rollbackTarget}.
 *   For `deploy`: artifact carries {commitHash}.
 *   For `monitoring`: when no prior successful deploy in history,
 *                     → hardHalt("no deploy commit").
 */
import { describe, expect, test } from "bun:test";
import {
  stageDeploy,
  stageMonitoring,
  stageRegression,
  stageSafetyChecks,
  stageSandboxApply,
  stageStaticAnalysis,
  stageTests,
  type StageHandlerDeps,
} from "../src/rsi/infra/contract-stages.ts";
import { makeInitialState, type ContractState, type StageResult } from "../src/rsi/infra/contract.ts";
import { DEFAULT_BUDGET_CAPS } from "../src/rsi/infra/budget.ts";
import type { PairedSample } from "../src/rsi/infra/confidence.ts";
import { fitnessVector, fitnessVectorAggregate } from "../src/rsi/l1-config/fitness.ts";
import type { FitnessVector } from "../src/rsi/infra/journal.ts";

/** Hand-written fake — no real eval, no real bridge. Each test overrides
 *  only the dep(s) it cares about; defaults are happy-path. */
function fakeDeps(over: Partial<StageHandlerDeps> = {}): StageHandlerDeps {
  const fv: FitnessVector = fitnessVector({ accuracy: 0.9 });
  const samples: PairedSample[] = Array.from({ length: 12 }, () => ({ candidate: 0.9, baseline: 0.5 }));
  return {
    validateCandidate: async () => ({ ok: true, findings: [] }),
    applySandbox: async () => ({ ok: true, rollbackTarget: "rollback-abc" }),
    runTier0: async () => ({ ok: true }),
    runBenchmark: async () => ({ fitnessVector: fv, aggregate: fitnessVectorAggregate(fv), samples }),
    runSafetyChecks: async () => ({ ok: true }),
    detectRegression: async () => ({ regressed: false }),
    deploy: async () => ({ advanced: true, commitHash: "commit-xyz" }),
    monitor: async () => ({ ok: true }),
    ...over,
  };
}

function freshState(over: Partial<ContractState> = {}): ContractState {
  return {
    ...makeInitialState({
      cycleId: "c-1",
      candidateId: "cand-1",
      layer: "L1",
      budgetCaps: DEFAULT_BUDGET_CAPS,
    }),
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// stageStaticAnalysis
// ─────────────────────────────────────────────────────────────────────────────
describe("stageStaticAnalysis", () => {
  test("ok when validateCandidate returns ok:true", async () => {
    const r = await stageStaticAnalysis(fakeDeps())(freshState());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stage).toBe("static_analysis");
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(r.artifact).toBeUndefined();
    }
  });

  test("softReject with joined findings when validateCandidate returns ok:false", async () => {
    const deps = fakeDeps({
      validateCandidate: async () => ({ ok: false, findings: ["unbound var x", "missing type"] }),
    });
    const r = await stageStaticAnalysis(deps)(freshState());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("static_analysis");
      expect(r.halt).toBe(false);
      expect(r.recoverable).toBe(true);
      expect(r.reason).toContain("unbound var x");
      expect(r.reason).toContain("missing type");
    }
  });

  test("hardHalt when validateCandidate throws (infra)", async () => {
    const deps = fakeDeps({ validateCandidate: async () => { throw new Error("boom"); } });
    const r = await stageStaticAnalysis(deps)(freshState());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.halt).toBe(true);
      expect(r.recoverable).toBe(false);
      expect(r.reason).toContain("infra failure");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stageSandboxApply
// ─────────────────────────────────────────────────────────────────────────────
describe("stageSandboxApply", () => {
  test("ok with artifact {rollbackTarget} on apply ok:true", async () => {
    const r = await stageSandboxApply(fakeDeps())(freshState());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stage).toBe("sandbox_apply");
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(r.artifact?.stage).toBe("sandbox_apply");
      expect(r.artifact?.data.rollbackTarget).toBe("rollback-abc");
    }
  });

  test("hardHalt on apply ok:false (infra — can't proceed safely)", async () => {
    const deps = fakeDeps({
      applySandbox: async () => ({ ok: false, rollbackTarget: "rb", reason: "sandbox unavailable" }),
    });
    const r = await stageSandboxApply(deps)(freshState());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.halt).toBe(true);
      expect(r.recoverable).toBe(false);
      expect(r.reason).toContain("sandbox unavailable");
    }
  });

  test("hardHalt when applySandbox throws", async () => {
    const deps = fakeDeps({ applySandbox: async () => { throw new Error("crash"); } });
    const r = await stageSandboxApply(deps)(freshState());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.halt).toBe(true);
      expect(r.recoverable).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stageTests
// ─────────────────────────────────────────────────────────────────────────────
describe("stageTests", () => {
  test("ok on tier0 pass", async () => {
    const r = await stageTests(fakeDeps())(freshState());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stage).toBe("tests");
      expect(r.artifact).toBeUndefined();
    }
  });

  test("softReject on tier0 ok:false", async () => {
    const deps = fakeDeps({ runTier0: async () => ({ ok: false, reason: "3 cases failed" }) });
    const r = await stageTests(deps)(freshState());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.halt).toBe(false);
      expect(r.recoverable).toBe(true);
      expect(r.reason).toBe("3 cases failed");
    }
  });

  test("hardHalt when runTier0 throws", async () => {
    const deps = fakeDeps({ runTier0: async () => { throw new Error("runner crashed"); } });
    const r = await stageTests(deps)(freshState());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.halt).toBe(true);
      expect(r.recoverable).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stageSafetyChecks
// ─────────────────────────────────────────────────────────────────────────────
describe("stageSafetyChecks", () => {
  test("ok on safety pass", async () => {
    const r = await stageSafetyChecks(fakeDeps())(freshState());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stage).toBe("safety_checks");
      expect(r.artifact).toBeUndefined();
    }
  });

  test("softReject on safety ok:false", async () => {
    const deps = fakeDeps({ runSafetyChecks: async () => ({ ok: false, reason: "SandboxBounds violated" }) });
    const r = await stageSafetyChecks(deps)(freshState());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.halt).toBe(false);
      expect(r.recoverable).toBe(true);
      expect(r.reason).toBe("SandboxBounds violated");
    }
  });

  test("hardHalt when runSafetyChecks throws", async () => {
    const deps = fakeDeps({ runSafetyChecks: async () => { throw new Error("policy engine down"); } });
    const r = await stageSafetyChecks(deps)(freshState());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.halt).toBe(true);
      expect(r.recoverable).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stageRegression
// ─────────────────────────────────────────────────────────────────────────────
describe("stageRegression", () => {
  test("ok when not regressed", async () => {
    const r = await stageRegression(fakeDeps())(freshState());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stage).toBe("regression");
      expect(r.artifact).toBeUndefined();
    }
  });

  test("softReject on regressed:true", async () => {
    const deps = fakeDeps({ detectRegression: async () => ({ regressed: true, reason: "tier1 drift" }) });
    const r = await stageRegression(deps)(freshState());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.halt).toBe(false);
      expect(r.recoverable).toBe(true);
      expect(r.reason).toBe("tier1 drift");
    }
  });

  test("hardHalt when detectRegression throws", async () => {
    const deps = fakeDeps({ detectRegression: async () => { throw new Error("goodhart offline"); } });
    const r = await stageRegression(deps)(freshState());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.halt).toBe(true);
      expect(r.recoverable).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stageDeploy
// ─────────────────────────────────────────────────────────────────────────────
describe("stageDeploy", () => {
  test("ok with artifact {commitHash} when ratchet advanced", async () => {
    const r = await stageDeploy(fakeDeps())(freshState());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stage).toBe("deploy");
      expect(r.artifact?.stage).toBe("deploy");
      expect(r.artifact?.data.commitHash).toBe("commit-xyz");
    }
  });

  test("softReject when ratchet declines (advanced:false — not a system fault)", async () => {
    const deps = fakeDeps({
      deploy: async () => ({ advanced: false, commitHash: "", reason: "aggregate 0.42 < ratchet 0.50" }),
    });
    const r = await stageDeploy(deps)(freshState());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.halt).toBe(false);
      expect(r.recoverable).toBe(true);
      expect(r.reason).toContain("ratchet");
    }
  });

  test("hardHalt when deploy throws (infra)", async () => {
    const deps = fakeDeps({ deploy: async () => { throw new Error("bridge down"); } });
    const r = await stageDeploy(deps)(freshState());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.halt).toBe(true);
      expect(r.recoverable).toBe(false);
    }
  });

  test("passes state.fitnessAggregate to deploy dep (defaults to 0 when undefined)", async () => {
    let seenAggregate: number | undefined;
    const deps = fakeDeps({
      deploy: async (_cid, aggregate) => {
        seenAggregate = aggregate;
        return { advanced: true, commitHash: "commit-xyz" };
      },
    });
    await stageDeploy(deps)(freshState()); // no fitnessAggregate → 0
    expect(seenAggregate).toBe(0);

    const state = freshState({ fitnessAggregate: 0.77 });
    await stageDeploy(deps)(state);
    expect(seenAggregate).toBe(0.77);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stageMonitoring
// ─────────────────────────────────────────────────────────────────────────────
describe("stageMonitoring", () => {
  test("hardHalt when no prior successful deploy commit in history", async () => {
    const r = await stageMonitoring(fakeDeps())(freshState()); // empty history
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.stage).toBe("monitoring");
      expect(r.halt).toBe(true);
      expect(r.recoverable).toBe(false);
      expect(r.reason).toBe("no deploy commit");
    }
  });

  test("ok when monitor returns ok:true against the deploy commit", async () => {
    const state = freshState();
    state.history.push({
      stage: "deploy",
      at: 0,
      result: {
        ok: true,
        stage: "deploy",
        durationMs: 1,
        artifact: { stage: "deploy", durationMs: 1, data: { commitHash: "commit-xyz" } },
      } satisfies StageResult,
    });
    const r = await stageMonitoring(fakeDeps())(state);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stage).toBe("monitoring");
      expect(r.artifact).toBeUndefined();
    }
  });

  test("softReject on monitor ok:false", async () => {
    const state = freshState();
    state.history.push({
      stage: "deploy",
      at: 0,
      result: {
        ok: true,
        stage: "deploy",
        durationMs: 1,
        artifact: { stage: "deploy", durationMs: 1, data: { commitHash: "commit-xyz" } },
      } satisfies StageResult,
    });
    const deps = fakeDeps({ monitor: async () => ({ ok: false, reason: "p99 latency spike" }) });
    const r = await stageMonitoring(deps)(state);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.halt).toBe(false);
      expect(r.recoverable).toBe(true);
      expect(r.reason).toBe("p99 latency spike");
    }
  });

  test("hardHalt when monitor throws", async () => {
    const state = freshState();
    state.history.push({
      stage: "deploy",
      at: 0,
      result: {
        ok: true,
        stage: "deploy",
        durationMs: 1,
        artifact: { stage: "deploy", durationMs: 1, data: { commitHash: "commit-xyz" } },
      } satisfies StageResult,
    });
    const deps = fakeDeps({ monitor: async () => { throw new Error("probe crashed"); } });
    const r = await stageMonitoring(deps)(state);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.halt).toBe(true);
      expect(r.recoverable).toBe(false);
    }
  });
});