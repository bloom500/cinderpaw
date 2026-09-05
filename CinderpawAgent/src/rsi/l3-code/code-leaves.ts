/**
 * Faza 2 Slice 4 — code-aware Contract leaves.
 * Spec: `docs/superpowers/specs/2026-07-01-faza2-code-rsi-design.md` §1.
 *
 * `contractLeavesForCodePatch` builds the `StageHandlerDeps` the Contract
 * FSM sequences for ONE code candidate — the same 8-stage machine the
 * config path rides, with the pass-through stages made REAL:
 *
 *   static_analysis → policy wall (Rust `rsi_validate_code_patch` — the
 *                     wall that matters is compiled, not TS)
 *   sandbox_apply   → the disposable-worktree pipeline (code-sandbox.ts):
 *                     apply + install + test + tsc + build, measurements
 *                     stashed on `run` for the later stages
 *   tests           → tier-0 analogue: the FULL existing suite must be
 *                     green in the worktree
 *   benchmark       → Rust-scored composite (I7: `rsi_score_code_patch`)
 *   safety_checks   → policy wall re-assert
 *   regression      → `bunx tsc --noEmit` verdict from the worktree run
 *   deploy          → Rust commit (`rsi_commit_code_patch`, policy
 *                     re-asserted a third time inside the binary) +
 *                     strict-greater ratchet (I1). SUBSTRATE-only: the
 *                     champion pointer moves; the patch is NOT applied to
 *                     the live source — live apply stays behind the
 *                     Slice 5 approval gate.
 *   monitoring      → pass-through (live-crash watchdog needs live apply)
 *
 * Confidence gate: code candidates have no per-task paired samples against
 * a champion baseline (their benchmark is test/tsc/build, not the eval
 * suite), so the runner gets a bootstrap-bypass gate — promotion is judged
 * by the tier-0-analogue tests stage + Rust strict-greater, exactly the
 * bootstrap semantics the config path uses before a baseline exists.
 */

import type { CodeGenome } from "./code-genome.ts";
import type { CodeEvalMeasurements, CodeEvalResult } from "./code-sandbox.ts";
import type { StageHandlerDeps } from "../infra/contract-stages.ts";
import type { GateDecision, PairedSample } from "../infra/confidence.ts";
import { scoreToFitnessVector } from "../l1-config/fitness.ts";
import type { RatchetAck } from "../infra/adapters.ts";

/** The primitives the code leaves compose. Production: bridge adapters
 *  (`makeCodeStageAdapters` in code-rsi.ts) + the Slice 2 worktree
 *  runner; tests inject fakes. */
export interface CodeStageDeps {
  /** Rust policy wall (`rsi_validate_code_patch`). Soft verdict. */
  validatePatch: (patch: string) => Promise<{ ok: boolean; reason?: string }>;
  /** The Slice 2 disposable-worktree pipeline (`evaluateCodePatch`). */
  evaluateInWorktree: (
    genome: Pick<CodeGenome, "patch" | "baseCommit">,
  ) => Promise<CodeEvalResult>;
  /** Rust code-score formula (I7: `rsi_score_code_patch`). */
  scorePatch: (m: CodeEvalMeasurements) => Promise<{ score: number }>;
  /** Rust substrate commit (`rsi_commit_code_patch`) — re-validates the
   *  policy inside the binary before anything is written. */
  commitCodePatch: (args: {
    genomeId: string;
    genome: CodeGenome;
    score: number;
  }) => Promise<{ commitHash: string }>;
  /** Rust strict-greater ratchet (I1) — same primitive as config-RSI. */
  ratchetAttempt: (
    commitHash: string,
    score: number,
  ) => Promise<RatchetAck>;
}

/** What the leaves learned while running — read by the caller after
 *  `runContract` returns. Mutated in place by the leaf closures. */
export interface CodeCandidateRun {
  measurements?: CodeEvalMeasurements;
  /** The Rust composite, set by the benchmark leaf. */
  score?: number;
  commitHash?: string;
  advanced?: boolean;
  previousBest?: number;
}

/** Build the per-candidate `StageHandlerDeps` for a code patch. */
export function contractLeavesForCodePatch(
  deps: CodeStageDeps,
  genome: CodeGenome,
  genomeId: string,
  run: CodeCandidateRun,
): StageHandlerDeps {
  // The worktree pipeline already ran everything; later stages read the
  // stashed measurements. A missing stash means the FSM sequenced wrong —
  // loud throw (infra), never a silent pass.
  const measured = (): CodeEvalMeasurements => {
    if (!run.measurements) {
      throw new Error("code leaves: no measurements — sandbox_apply did not run");
    }
    return run.measurements;
  };

  return {
    validateCandidate: async () => {
      const v = await deps.validatePatch(genome.patch);
      return { ok: v.ok, findings: v.ok ? [] : [v.reason ?? "policy violation"] };
    },

    applySandbox: async () => {
      const r = await deps.evaluateInWorktree(genome);
      if (!r.ok) {
        // Worktree/apply/install failure is INFRA (hard halt per the
        // stage table) — a patch that does not apply was already the
        // proposer's fault, but we cannot distinguish it from a broken
        // sandbox here; fail safe.
        return { ok: false, rollbackTarget: genome.baseCommit, reason: `${r.stage}: ${r.reason}` };
      }
      run.measurements = r.measurements;
      // Nothing live was touched — the "rollback target" is the base
      // the disposable worktree was cut from, recorded for the journal.
      return { ok: true, rollbackTarget: genome.baseCommit };
    },

    // Tier-0 analogue: the ENTIRE existing suite is the frozen floor. A
    // single failing test in the patched copy rejects the candidate.
    runTier0: async () => {
      const m = measured();
      if (m.testsFailed > 0 || m.testsExitCode !== 0) {
        return {
          ok: false,
          reason: `worktree tests failed: ${m.testsFailed} fail (exit ${m.testsExitCode})`,
        };
      }
      return { ok: true };
    },

    runBenchmark: async () => {
      const { score } = await deps.scorePatch(measured());
      run.score = score;
      const fitnessVector = scoreToFitnessVector(score);
      return {
        fitnessVector,
        aggregate: fitnessVector.accuracy,
        // No paired eval-suite samples for a code candidate — the gate
        // is bypassed (see module docblock).
        samples: [],
      };
    },

    // Spec table: policy re-assert. Free, and it means a wall change
    // between proposal and promotion is still caught.
    runSafetyChecks: async () => {
      const v = await deps.validatePatch(genome.patch);
      return v.ok ? { ok: true } : { ok: false, reason: v.reason ?? "policy violation" };
    },

    // Spec table: regression = the type-checker over the patched copy.
    detectRegression: async () => {
      const m = measured();
      return m.tscExitCode === 0
        ? { regressed: false }
        : { regressed: true, reason: `tsc --noEmit failed (exit ${m.tscExitCode})` };
    },

    deploy: async () => {
      const score = run.score;
      if (score === undefined) throw new Error("deploy reached without a benchmark score");
      const { commitHash } = await deps.commitCodePatch({ genomeId, genome, score });
      run.commitHash = commitHash;
      const r = await deps.ratchetAttempt(commitHash, score);
      run.advanced = r.advanced;
      run.previousBest = r.previousBest;
      return {
        advanced: r.advanced,
        commitHash,
        ...(r.advanced
          ? {}
          : {
              // Third copy of this message in the tree; all three printed a
              // comparison the ratchet never made. `candidateScore` is the
              // score read from the commit metadata, which is the only side
              // the Rust ratchet looks at.
              reason: r.hadPrior
                ? `ratchet declined: candidate scored ${r.candidateScore}, main already scores ${r.previousBest} (strictly greater required)`
                : `ratchet declined: candidate scored ${r.candidateScore} and main carries no parseable score to beat`,
            }),
      };
    },

    // ponytail: no live-crash watchdog until a patch can be live-applied
    // (Slice 5 approval gate) — there is nothing running to monitor.
    monitor: async () => ({ ok: true }),
  };
}

/** Bootstrap-bypass confidence gate for code candidates (no paired
 *  eval-suite baseline exists — see module docblock). */
export function codeGateBypass(): (samples: readonly PairedSample[]) => GateDecision {
  return () => ({
    accept: true,
    reason: "confidence gate bypassed: code candidates have no paired eval-suite baseline",
    bootstrap: { mean: 0, ciLower: 0, ciUpper: 0, pValue: 0, effectSize: 0 },
  });
}
