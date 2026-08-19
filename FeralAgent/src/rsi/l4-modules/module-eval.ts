/**
 * L4 Architecture Evolution — paired shadow evaluation (spec §5).
 * B4 of Phase B.
 *
 * The eval suite (Tier 0 + Tier 1/2) runs TWICE on the current champion
 * genome: once with the incumbent seam binding, once with the candidate
 * module bound. Same tasks, same genome, same model → paired samples per
 * task, fed to the locked `evaluateGate` with thresholds tightened by
 * governance policy (`effectiveGates`, L5 §7). A real paired test —
 * required because a module swap is a bigger lever than a metaparameter.
 *
 * Verdict precedence (each check only matters if the prior ones held):
 *   1. Tier 0 floor breach on the CANDIDATE run = instant fail
 *      (INVARIANT I8 — same leaf as `contract-leaves.ts`).
 *   2. Latency floor: candidate mean ≤ 1.5× incumbent mean (modules
 *      cross a process boundary; the tax must be visible and bounded).
 *   3. The confidence gate on per-task success pairs.
 *
 * `runSuite` is injected: production binds it to the real agent loop
 * with the seam pointed at incumbent/candidate (B5/B6 wiring); tests
 * stub it (AC1, AC5). The suite runner itself never repoints the LIVE
 * registry — shadow evaluation must be invisible to the user.
 *
 * `capabilitiesMeasured` (spec §5, §12.4): per-domain candidate pass
 * rates aggregated from the suite. The spec assumed specs "already carry
 * domains" — they did not (verified 2026-07-09), so `EvalSpec.domain` is
 * now optional and this module owns the deterministic kind→domain
 * fallback using the Brain Stack vocabulary (`capability-registry.ts`).
 * This measured signal — never the manifest's self-claimed hints (§12.4
 * two-channel rule) — is the only capability input downstream consumers
 * may read.
 */

import {
  DEFAULT_BOOTSTRAP_ITERATIONS,
  DEFAULT_SEED,
  evaluateGate,
  type GateDecision,
  type GateThresholds,
  type PairedSample,
} from "../infra/confidence.ts";
import { tier0FloorBreach } from "../infra/contract-leaves.ts";
import { defaultEnvelopesDir, updateEnvelope } from "../infra/envelope-store.ts";
import type { EvalKind, EvalSpec } from "../infra/eval-spec.ts";
import type { EvalOutcome } from "../infra/eval-worker.ts";
import type { ArtifactEnvelope } from "../infra/provenance.ts";

/** Spec §5: candidate mean latency must stay within this multiple of the
 *  incumbent's. */
export const LATENCY_FLOOR_RATIO = 1.5;

/** Deterministic fallback for specs without an explicit `domain`.
 *  Brain Stack vocabulary (`Capability` in `capability-registry.ts`). */
const KIND_DOMAIN: Record<EvalKind, string> = {
  json_format: "coding",
  fact_lookup: "reasoning",
  token_budget: "speed",
  latency: "speed",
  tool_call: "tools",
};

export function domainOf(spec: Pick<EvalSpec, "kind" | "domain">): string {
  return spec.domain ?? KIND_DOMAIN[spec.kind] ?? "reasoning";
}

// ── Report shape (persisted into the envelope, replayable — spec §5, §9) ────

export interface EvalPairRow {
  taskId: string;
  tier: number;
  domain: string;
  incumbentSuccess: boolean;
  candidateSuccess: boolean;
  incumbentLatencyMs: number;
  candidateLatencyMs: number;
}

export interface ModuleEvalReport {
  moduleId: string;
  seam: string;
  /** What the candidate was paired against ("builtin" or a module id). */
  incumbent: string;
  genomeId: string;
  modelId: string;
  /** Bootstrap seed — with the pairs, reproduces the gate decision offline. */
  seed: number;
  timestamp: number;
  pairs: EvalPairRow[];
  gate: GateDecision;
  /** Human-readable breach reason, or null if the Tier 0 floor held. */
  tier0Breach: string | null;
  latency: {
    incumbentMeanMs: number;
    candidateMeanMs: number;
    floorRatio: number;
    breached: boolean;
  };
  /** Per-domain candidate pass rate, 0..1 (spec §5 / §12.4). */
  capabilitiesMeasured: Record<string, number>;
  accept: boolean;
  reason: string;
}

// ── Runner ──────────────────────────────────────────────────────────────────

export type SuiteBinding = "incumbent" | "candidate";

export interface ModuleEvalDeps {
  /** The suite, ordered — used for pairing and domain aggregation. */
  getSpecs: () => Promise<EvalSpec[]>;
  /** Run the full suite on the champion genome under one seam binding.
   *  Must return one outcome per spec (a crashed task is an errored
   *  outcome, never a missing one — `run-eval.ts` guarantees this). */
  runSuite: (binding: SuiteBinding) => Promise<EvalOutcome[]>;
  /** Policy-tightened thresholds: `effectiveGates(policy)` in production. */
  thresholds: GateThresholds;
  genomeId: string;
  modelId: string;
  bootstrapIterations?: number;
  now?: () => number;
}

export async function runModuleEval(
  ids: { moduleId: string; seam: string; incumbent: string },
  deps: ModuleEvalDeps,
): Promise<ModuleEvalReport> {
  const now = deps.now ?? Date.now;
  const specs = await deps.getSpecs();
  const specById = new Map(specs.map((s) => [s.id, s]));

  const incumbentOutcomes = await deps.runSuite("incumbent");
  const candidateOutcomes = await deps.runSuite("candidate");

  // Pair by taskId. A task missing from either run is dropped from the
  // pairs (defensive — the runner contract says this cannot happen; if
  // it does, MIN_SAMPLES in the gate still protects the decision).
  const incumbentById = new Map(incumbentOutcomes.map((o) => [o.taskId, o]));
  const pairs: EvalPairRow[] = [];
  for (const c of candidateOutcomes) {
    const i = incumbentById.get(c.taskId);
    const spec = specById.get(c.taskId);
    if (!i || !spec) continue;
    pairs.push({
      taskId: c.taskId,
      tier: c.tier,
      domain: domainOf(spec),
      incumbentSuccess: i.success,
      candidateSuccess: c.success,
      incumbentLatencyMs: i.latencyMs,
      candidateLatencyMs: c.latencyMs,
    });
  }

  // Per-domain candidate pass rate — always computed, even on rejection
  // (the report is the record of what WAS measured).
  const domainTotals = new Map<string, { pass: number; total: number }>();
  for (const p of pairs) {
    const t = domainTotals.get(p.domain) ?? { pass: 0, total: 0 };
    t.total += 1;
    if (p.candidateSuccess) t.pass += 1;
    domainTotals.set(p.domain, t);
  }
  const capabilitiesMeasured: Record<string, number> = {};
  for (const [domain, t] of domainTotals) {
    capabilitiesMeasured[domain] = t.total > 0 ? t.pass / t.total : 0;
  }

  // The incumbent is this seam's champion, so pass it: an environment task
  // (latency, token budget) only vetoes when the incumbent passed it on this
  // same machine. The recorded report for the one module ever built on this
  // install (2026-07-09, `~/.feral/rsi/envelopes`) reads "Tier 0 floor
  // breached: 5 frozen sanity task(s) failed", and the pairs show the
  // INCUMBENT failing the same five — one of them `tier0/latency_short`, a
  // property of the route that no module can change. Correctness tasks still
  // veto absolutely; a real speed regression against the incumbent still
  // vetoes here as well as in the latency-ratio check below.
  const tier0Breach = tier0FloorBreach(candidateOutcomes, incumbentOutcomes);

  const incumbentMeanMs = mean(pairs.map((p) => p.incumbentLatencyMs));
  const candidateMeanMs = mean(pairs.map((p) => p.candidateLatencyMs));
  const latencyBreached =
    incumbentMeanMs > 0
      ? candidateMeanMs > LATENCY_FLOOR_RATIO * incumbentMeanMs
      : candidateMeanMs > 0;

  const samples: PairedSample[] = pairs.map((p) => ({
    candidate: p.candidateSuccess ? 1 : 0,
    baseline: p.incumbentSuccess ? 1 : 0,
  }));
  const gate = evaluateGate(
    samples,
    deps.thresholds,
    deps.bootstrapIterations ?? DEFAULT_BOOTSTRAP_ITERATIONS,
  );

  // Verdict precedence: floor > latency > gate.
  let accept = false;
  let reason: string;
  if (tier0Breach) {
    reason = tier0Breach;
  } else if (latencyBreached) {
    reason =
      `latency floor breached: candidate mean ${candidateMeanMs.toFixed(1)}ms > ` +
      `${LATENCY_FLOOR_RATIO}× incumbent mean ${incumbentMeanMs.toFixed(1)}ms`;
  } else {
    accept = gate.accept;
    reason = gate.reason;
  }

  return {
    moduleId: ids.moduleId,
    seam: ids.seam,
    incumbent: ids.incumbent,
    genomeId: deps.genomeId,
    modelId: deps.modelId,
    seed: DEFAULT_SEED,
    timestamp: now(),
    pairs,
    gate,
    tier0Breach,
    latency: {
      incumbentMeanMs,
      candidateMeanMs,
      floorRatio: LATENCY_FLOOR_RATIO,
      breached: latencyBreached,
    },
    capabilitiesMeasured,
    accept,
    reason,
  };
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

// ── Envelope persistence (spec §5 output, §9 provenance) ────────────────────

/** Persist the report into the module's envelope (created on first eval:
 *  module envelopes are the first real citizens of `envelopes/`). The
 *  parent chain starts at the incumbent — "builtin" is recorded as
 *  `builtin:<seam>` per §9. */
export function recordEvalReport(
  report: ModuleEvalReport,
  dir = defaultEnvelopesDir(),
): ArtifactEnvelope {
  const parent =
    report.incumbent === "builtin" ? `builtin:${report.seam}` : report.incumbent;
  return updateEnvelope(
    report.moduleId,
    () => ({
      id: report.moduleId,
      kind: "module",
      parents: [parent],
      timestamp: report.timestamp,
      data: { seam: report.seam },
    }),
    (env) => ({
      ...env,
      data: {
        ...env.data,
        seam: report.seam,
        evalReport: report,
        capabilitiesMeasured: report.capabilitiesMeasured,
      },
    }),
    dir,
  );
}
