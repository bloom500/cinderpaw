/**
 * Evolution Contract stage handlers (BRSI §2.1) — the 8 `StageFn` leaves the
 * `runContract` runner sequences. Each is a FACTORY `stageX(deps): StageFn`
 * that composes injected primitives into a `StageResult` with the artifact
 * shape the runner reads (see `contract-runner.ts` docblock).
 *
 * ── Division of labor ───────────────────────────────────────────────────────
 * The `StageHandlerDeps` interface below is the FIXED CONTRACT. The handler
 * bodies are pure composition: call an injected dep, map its result to a
 * `StageResult`, attach the required artifact. Handlers do NOT touch the Rust
 * bridge, `engine.ts`, or the git substrate directly — those primitives are
 * injected and wired by the engine composition root. This keeps the trust
 * boundary (I1 ratchet, I7 scorer) on the engine side; the handlers only
 * sequence work and shape verdicts.
 *
 * ── The StageResult mapping every handler follows ───────────────────────────
 *   success  → { ok: true, stage, durationMs, artifact?: {...} }
 *   soft fail → { ok: false, stage, reason, halt: false, recoverable: true }
 *               // "try a different candidate" — the runner records `reject`
 *   hard fail → { ok: false, stage, reason, halt: true,  recoverable: false }
 *               // system-wide stop — the runner records `halt`
 *
 * Guidance on which failures are hard vs soft:
 *   - static_analysis / tests / safety_checks / regression → SOFT (this
 *     candidate is bad; the engine tries another). Exception: an INFRA failure
 *     (dep threw / sandbox unavailable) is HARD.
 *   - sandbox_apply / deploy infra failure → HARD (can't proceed safely).
 *   - deploy where the Rust ratchet declines (`advanced:false`) → SOFT (the
 *     strict-greater source of truth said no; not a system fault).
 */
import type { ContractStage, ContractState, StageFn, StageResult } from "./contract.ts";
import type { PairedSample } from "./confidence.ts";
import type { FitnessVector } from "./journal.ts";

/**
 * The primitives each stage handler needs, injected by the engine composition
 * root (Opus wires these to eval-worker / the Rust bridge / goodhart). This is
 * the frozen contract the handlers compose against — do not widen it without
 * an ADR.
 */
export interface StageHandlerDeps {
  /** static_analysis — validate the candidate genome against the mutation-
   *  grammar bounds. `ok:false` → the candidate is malformed (soft reject). */
  validateCandidate: (candidateId: string) => Promise<{ ok: boolean; findings: string[] }>;

  /** sandbox_apply — materialize the candidate in the sandbox and return the
   *  commit to roll back to. `ok:false` → infra failure (hard halt). */
  applySandbox: (candidateId: string) => Promise<{ ok: boolean; rollbackTarget: string; reason?: string }>;

  /** tests — run the Tier 0 (regression-critical) eval suite. `ok:false` →
   *  tier0 failed (soft reject). */
  runTier0: (candidateId: string) => Promise<{ ok: boolean; reason?: string }>;

  /** benchmark — run the eval suite for the candidate AND the baseline, and
   *  produce the fitness vector + paired samples the I6 gate consumes. Throws
   *  only on infra failure. */
  runBenchmark: (candidateId: string) => Promise<{
    fitnessVector: FitnessVector;
    aggregate: number;
    samples: PairedSample[];
    /** Components carrying the neutral placeholder instead of a measurement.
     *  Optional so existing fakes keep compiling; absent is read as "the
     *  handler did not say", not as "everything was measured". */
    unmeasured?: string[];
  }>;

  /** safety_checks — SandboxBounds / policy gate. `ok:false` → soft reject. */
  runSafetyChecks: (candidateId: string) => Promise<{ ok: boolean; reason?: string }>;

  /** regression — Tier 1 no-regression check (goodhart, Rust-side).
   *  `regressed:true` → soft reject. */
  detectRegression: (candidateId: string) => Promise<{ regressed: boolean; reason?: string }>;

  /** deploy — attempt to ratchet the candidate onto the main lineage. Rust is
   *  the source of truth (I1); `advanced:false` → soft reject. */
  deploy: (candidateId: string, aggregate: number) => Promise<{ advanced: boolean; commitHash: string; reason?: string }>;

  /** monitoring — post-deploy health check on the newly promoted commit.
   *  `ok:false` → soft reject (the deploy landed but looks unhealthy). */
  monitor: (commitHash: string) => Promise<{ ok: boolean; reason?: string }>;
}

/** Small helpers the handlers reuse. Kept here so the leaf bodies stay short. */
function ok(stage: ContractStage, durationMs: number, artifact?: { data: Record<string, unknown> }): StageResult {
  return { ok: true, stage, durationMs, ...(artifact && { artifact: { stage, durationMs, data: artifact.data } }) };
}
function softReject(stage: ContractStage, reason: string): StageResult {
  return { ok: false, stage, reason, halt: false, recoverable: true };
}
function hardHalt(stage: ContractStage, reason: string): StageResult {
  return { ok: false, stage, reason, halt: true, recoverable: false };
}

/** The commit hash the deploy stage recorded — for the monitoring handler. */
function deployCommitHash(state: ContractState): string | undefined {
  for (let i = state.history.length - 1; i >= 0; i--) {
    const h = state.history[i]!;
    if (h.stage === "deploy" && h.result.ok) {
      const c = h.result.artifact?.data.commitHash;
      return typeof c === "string" ? c : undefined;
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE HANDLER — benchmark. Fully worked so the artifact shape + timing +
// infra-vs-verdict distinction are unambiguous. Implement the other 7 in the
// same style. This one produces the artifact the runner AND the I6 gate read,
// so it is the one worth copying carefully.
// ─────────────────────────────────────────────────────────────────────────────
export function stageBenchmark(deps: StageHandlerDeps): StageFn {
  return async (state) => {
    const t0 = Date.now();
    try {
      const { fitnessVector, aggregate, samples, unmeasured } = await deps.runBenchmark(
        state.candidateId,
      );
      return ok("benchmark", Date.now() - t0, {
        data: { fitnessVector, aggregate, samples, ...(unmeasured ? { unmeasured } : {}) },
      });
    } catch (e) {
      // Infra failure (eval crashed) — hard halt, not a candidate verdict.
      return hardHalt("benchmark", `benchmark infra failure: ${String(e)}`);
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MiniMax: implement the 7 factories below in the style of `stageBenchmark`.
// Each returns a `StageFn` closing over `deps`; measure duration with
// `Date.now()`; map dep results per the header's hard/soft table; attach only
// the artifact the runner reads (sandbox_apply → {rollbackTarget}, deploy →
// {commitHash}; the rest need no artifact). Replace each throw with the body.
// ─────────────────────────────────────────────────────────────────────────────

export function stageStaticAnalysis(deps: StageHandlerDeps): StageFn {
  return async (state) => {
    const t0 = Date.now();
    try {
      const { ok: valid, findings } = await deps.validateCandidate(state.candidateId);
      if (valid) return ok("static_analysis", Date.now() - t0);
      return softReject("static_analysis", `static_analysis findings: ${findings.join("; ")}`);
    } catch (e) {
      return hardHalt("static_analysis", `static_analysis infra failure: ${String(e)}`);
    }
  };
}

export function stageSandboxApply(deps: StageHandlerDeps): StageFn {
  return async (state) => {
    const t0 = Date.now();
    try {
      const { ok: applied, rollbackTarget, reason } = await deps.applySandbox(state.candidateId);
      if (!applied) {
        return hardHalt("sandbox_apply", `sandbox_apply infra failure: ${reason ?? "apply failed"}`);
      }
      return ok("sandbox_apply", Date.now() - t0, { data: { rollbackTarget } });
    } catch (e) {
      return hardHalt("sandbox_apply", `sandbox_apply infra failure: ${String(e)}`);
    }
  };
}

export function stageTests(deps: StageHandlerDeps): StageFn {
  return async (state) => {
    const t0 = Date.now();
    try {
      const { ok: tier0Passed, reason } = await deps.runTier0(state.candidateId);
      if (tier0Passed) return ok("tests", Date.now() - t0);
      return softReject("tests", reason ?? "tier0 failed");
    } catch (e) {
      return hardHalt("tests", `tests infra failure: ${String(e)}`);
    }
  };
}

export function stageSafetyChecks(deps: StageHandlerDeps): StageFn {
  return async (state) => {
    const t0 = Date.now();
    try {
      const { ok: safe, reason } = await deps.runSafetyChecks(state.candidateId);
      if (safe) return ok("safety_checks", Date.now() - t0);
      return softReject("safety_checks", reason ?? "safety checks failed");
    } catch (e) {
      return hardHalt("safety_checks", `safety_checks infra failure: ${String(e)}`);
    }
  };
}

export function stageRegression(deps: StageHandlerDeps): StageFn {
  return async (state) => {
    const t0 = Date.now();
    try {
      const { regressed, reason } = await deps.detectRegression(state.candidateId);
      if (!regressed) return ok("regression", Date.now() - t0);
      return softReject("regression", reason ?? "regression detected");
    } catch (e) {
      return hardHalt("regression", `regression infra failure: ${String(e)}`);
    }
  };
}

export function stageDeploy(deps: StageHandlerDeps): StageFn {
  return async (state) => {
    const t0 = Date.now();
    try {
      const { advanced, commitHash, reason } = await deps.deploy(
        state.candidateId,
        state.fitnessAggregate ?? 0,
      );
      if (advanced) return ok("deploy", Date.now() - t0, { data: { commitHash } });
      return softReject("deploy", reason ?? "ratchet declined");
    } catch (e) {
      return hardHalt("deploy", `deploy infra failure: ${String(e)}`);
    }
  };
}

export function stageMonitoring(deps: StageHandlerDeps): StageFn {
  return async (state) => {
    const t0 = Date.now();
    const commit = deployCommitHash(state);
    if (commit === undefined) {
      return hardHalt("monitoring", "no deploy commit");
    }
    try {
      const { ok: healthy, reason } = await deps.monitor(commit);
      if (healthy) return ok("monitoring", Date.now() - t0);
      return softReject("monitoring", reason ?? "monitoring unhealthy");
    } catch (e) {
      return hardHalt("monitoring", `monitoring infra failure: ${String(e)}`);
    }
  };
}
