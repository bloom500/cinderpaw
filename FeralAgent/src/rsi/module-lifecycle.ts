/**
 * L4 Architecture Evolution — the lifecycle state machine (spec §3, §6).
 * B5 of Phase B.
 *
 * One class orchestrates a module candidate from `proposed` to a terminal
 * state. The operative state lives in the module's ENVELOPE
 * (`envelope.data.state` — the envelope is the registry's source of truth
 * for lineage, §2.2); every transition also appends a history row (§3)
 * and consults L5:
 *
 *   - freeze: `layerFrozen("l4")` refuses every step while frozen (§7);
 *   - promotion additionally passes `governanceCheck("l4_module_promote")`
 *     with the approval — the same one-door discipline as L2/L3/L6.
 *
 * Promotion (§6) is the ONLY path that repoints a seam to a module:
 *   evaluated(gate accept) → contract FSM pass (ONE journal row, layer
 *   "L4", exactly like L1/L3 candidates) → awaiting_approval → human
 *   approve → envelope stamped (approvedBy/promotedAt) → registry
 *   repoint. The seam adapter re-resolves on the next request — no
 *   restart. Rollback (demote) is always free and instant (§8.1).
 *
 * Serialization (§3): at most ONE candidate per seam past `built` —
 * enforced at `evaluate()`, mirroring the loraTrainBusy one-at-a-time
 * discipline.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BUDGET_CAPS } from "./budget.ts";
import { evaluateGate } from "./confidence.ts";
import { makeInitialState, type ContractDeps } from "./contract.ts";
import { runContract } from "./contract-runner.ts";
import { defaultEnvelopesDir, readEnvelope, updateEnvelope, writeEnvelope } from "./envelope-store.ts";
import { appendGovernanceAudit } from "./governance-audit.ts";
import {
  defaultGovernanceDir,
  effectiveGates,
  governanceCheck,
  layerFrozen,
  loadPolicy,
} from "./governance.ts";
import { appendJournal, defaultJournalPath } from "./journal.ts";
import { runModuleEval, recordEvalReport, type ModuleEvalDeps, type ModuleEvalReport } from "./module-eval.ts";
import { spawnModuleHost } from "./module-host-client.ts";
import { defaultModulesDir, loadManifest, type ModuleManifest, type ModuleRegistry } from "./module-registry.ts";
import { wallCheck } from "./module-wall.ts";
import type { ArtifactEnvelope } from "./provenance.ts";

/** Spec §3. Terminal states keep their directory + envelope; nothing is
 *  deleted. `incompatible` is written by the registry's boot reconcile;
 *  `quarantined` by the seam-adapter watchdog — both recoverable via a
 *  fresh evaluation. */
export type ModuleState =
  | "proposed"
  | "sandboxed"
  | "built"
  | "evaluated"
  | "awaiting_approval"
  | "promoted"
  | "failed"
  | "rejected"
  | "withdrawn"
  | "retired"
  | "quarantined"
  | "incompatible";

/** States a fresh evaluation may start from (re-promotion after
 *  quarantine/incompatible requires fresh evidence — §8). */
const EVALUATABLE: ReadonlySet<ModuleState> = new Set([
  "built",
  "evaluated",
  "quarantined",
  "incompatible",
]);

export type StepResult = { ok: true; state: ModuleState } | { ok: false; reason: string };

/** Candidates older than this without approval are withdrawn (§6). */
export const STALE_CANDIDATE_MS = 30 * 24 * 60 * 60_000;

export interface ModuleLifecycleOpts {
  registry: ModuleRegistry;
  /** Runtime version for manifest compat checks. */
  runtimeVersion: string;
  modulesDir?: string;
  envelopesDir?: string;
  governanceDir?: string;
  /** Journal path for the contract FSM row. Default: today's file. */
  journalPath?: () => string;
  /** Injectable for tests. Production: `spawnModuleHost`. */
  spawn?: typeof spawnModuleHost;
  now?: () => number;
  log?: (msg: string) => void;
}

export class ModuleLifecycle {
  private readonly registry: ModuleRegistry;
  private readonly runtimeVersion: string;
  private readonly modulesDir: string;
  private readonly envelopesDir: string;
  private readonly governanceDir: string;
  private readonly journalPath: () => string;
  private readonly spawn: typeof spawnModuleHost;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  /** §3: one candidate per seam past `built`, serialized. */
  private evalBusy = new Set<string>();

  constructor(opts: ModuleLifecycleOpts) {
    this.registry = opts.registry;
    this.runtimeVersion = opts.runtimeVersion;
    this.modulesDir = opts.modulesDir ?? defaultModulesDir();
    this.envelopesDir = opts.envelopesDir ?? defaultEnvelopesDir();
    this.governanceDir = opts.governanceDir ?? defaultGovernanceDir();
    this.journalPath = opts.journalPath ?? defaultJournalPath;
    this.spawn = opts.spawn ?? spawnModuleHost;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  // ── Reads ────────────────────────────────────────────────────────────

  stateOf(moduleId: string): ModuleState | null {
    const env = readEnvelope(moduleId, this.envelopesDir);
    const s = env?.data.state;
    return typeof s === "string" ? (s as ModuleState) : null;
  }

  envelopeOf(moduleId: string): ArtifactEnvelope | null {
    return readEnvelope(moduleId, this.envelopesDir);
  }

  manifestOf(moduleId: string): ModuleManifest | null {
    const res = loadManifest(join(this.modulesDir, moduleId), {
      runtimeVersion: this.runtimeVersion,
    });
    return res.ok ? res.manifest : null;
  }

  // ── Transitions (spec §3) ────────────────────────────────────────────

  /** proposed: validate the manifest, mint the envelope. */
  propose(moduleId: string): StepResult {
    const frozen = this.frozenCheck();
    if (frozen) return frozen;
    const res = loadManifest(join(this.modulesDir, moduleId), {
      runtimeVersion: this.runtimeVersion,
    });
    if (!res.ok) return { ok: false, reason: `manifest rejected: ${res.reason}` };
    if (res.manifest.id !== moduleId) {
      return { ok: false, reason: `manifest id ${res.manifest.id} ≠ directory id ${moduleId}` };
    }
    const existing = this.stateOf(moduleId);
    if (existing) return { ok: false, reason: `module already exists in state ${existing}` };
    writeEnvelope(
      {
        id: moduleId,
        kind: "module",
        parents: [this.parentFor(res.manifest.seam)],
        timestamp: this.now(),
        data: { state: "proposed", seam: res.manifest.seam, manifest: res.manifest },
      },
      this.envelopesDir,
    );
    this.transition(res.manifest.seam, moduleId, "(none)", "proposed", res.manifest.proposedBy, "manifest valid");
    return { ok: true, state: "proposed" };
  }

  /** sandboxed: the lexical wall over the entry source (§4). */
  sandbox(moduleId: string): StepResult {
    return this.step(moduleId, ["proposed"], "sandboxed", () => {
      const manifest = this.manifestOf(moduleId);
      if (!manifest) return "manifest unreadable";
      let source: string;
      try {
        source = readFileSync(join(this.modulesDir, moduleId, manifest.entry), "utf8");
      } catch (err) {
        return `entry unreadable: ${String(err)}`;
      }
      const wall = wallCheck(source);
      return wall.ok ? null : `lexical wall: ${wall.reason}`;
    });
  }

  /** built: spawn the real host, require the hello handshake, stop.
   *  Proof the module imports and speaks the protocol inside the sandbox
   *  (§4 build step — no separate bundler pass needed for single-file
   *  stdlib-pure modules; the import IS the build). */
  async build(moduleId: string): Promise<StepResult> {
    const manifest = this.manifestOf(moduleId);
    return this.stepAsync(moduleId, ["sandboxed"], "built", async () => {
      if (!manifest) return "manifest unreadable";
      const res = await this.spawn({
        moduleDir: join(this.modulesDir, moduleId),
        limits: manifest.limits,
        log: this.log,
      });
      if (!res.ok) return `host spawn failed: ${res.reason}`;
      res.host.stop();
      await res.host.exited; // Windows: release the module-dir cwd before returning
      return null;
    });
  }

  /** evaluated → contract FSM → awaiting_approval (spec §5 + §6 gates).
   *  `evalDeps` is the paired-eval harness (production: champion genome +
   *  real suite with the seam bound incumbent/candidate; tests: stubs). */
  async evaluate(
    moduleId: string,
    evalDeps: Omit<ModuleEvalDeps, "thresholds"> & { cycleId?: string },
  ): Promise<StepResult & { report?: ModuleEvalReport }> {
    const frozen = this.frozenCheck();
    if (frozen) return frozen;
    const state = this.stateOf(moduleId);
    if (!state || !EVALUATABLE.has(state)) {
      return { ok: false, reason: `cannot evaluate from state ${state ?? "(missing)"}` };
    }
    const manifest = this.manifestOf(moduleId);
    if (!manifest) return { ok: false, reason: "manifest unreadable" };
    const seam = manifest.seam;

    // §3: at most one candidate per seam in flight past `built`.
    const others = this.registry.candidatesFor(seam).filter((c) => c !== moduleId);
    if (others.length > 0) {
      return { ok: false, reason: `seam ${seam} already has a candidate in flight: ${others[0]}` };
    }
    if (this.evalBusy.has(seam)) {
      return { ok: false, reason: `seam ${seam} evaluation already running` };
    }
    this.evalBusy.add(seam);
    try {
      const thresholds = effectiveGates(loadPolicy(this.governanceDir).policy);
      const incumbent = this.registry.activeFor(seam);
      const report = await runModuleEval(
        { moduleId, seam, incumbent },
        { ...evalDeps, thresholds },
      );
      recordEvalReport(report, this.envelopesDir);

      if (!report.accept) {
        this.setState(moduleId, "failed");
        this.transition(seam, moduleId, state, "failed", "dream", `eval rejected: ${report.reason}`);
        return { ok: false, reason: report.reason, report };
      }
      this.setState(moduleId, "evaluated");
      this.transition(seam, moduleId, state, "evaluated", "dream", report.reason);

      // §6.2 — the Evolution Contract FSM: one journal row per candidate,
      // layer "L4", exactly like L1/L3. Stages are thin adapters over the
      // evidence this pipeline already produced.
      const fsm = await this.runL4Contract(moduleId, report, evalDeps.cycleId, thresholds);
      if (!fsm.ok) {
        this.setState(moduleId, "failed");
        this.transition(seam, moduleId, "evaluated", "failed", "dream", `contract FSM: ${fsm.reason}`);
        return { ok: false, reason: `contract FSM: ${fsm.reason}`, report };
      }

      this.registry.addCandidate(seam, moduleId);
      this.setState(moduleId, "awaiting_approval");
      this.transition(seam, moduleId, "evaluated", "awaiting_approval", "dream", "gates passed — human approval required");
      return { ok: true, state: "awaiting_approval", report };
    } finally {
      this.evalBusy.delete(seam);
    }
  }

  /** promoted (§6.4-5). The ONLY path to `registry.active` = module id.
   *  `approver` is the recorded human decision (AC6: no approval record,
   *  no promotion — every surface routes through here). */
  approve(moduleId: string, approver: string): StepResult {
    const state = this.stateOf(moduleId);
    if (state !== "awaiting_approval") {
      return { ok: false, reason: `not awaiting approval (state: ${state ?? "(missing)"})` };
    }
    const gc = governanceCheck("l4_module_promote", {
      dir: this.governanceDir,
      approvalPresent: true,
    });
    if (!gc.allowed) return { ok: false, reason: gc.reason };
    const manifest = this.manifestOf(moduleId);
    if (!manifest) return { ok: false, reason: "manifest unreadable" };

    updateEnvelope(
      moduleId,
      () => this.missingEnvelope(moduleId),
      (env) => ({
        ...env,
        data: { ...env.data, state: "promoted", approvedBy: approver, promotedAt: this.now() },
      }),
      this.envelopesDir,
    );
    // repoint appends its own history row + governance audit (B1).
    const rp = this.registry.repoint(manifest.seam, moduleId, approver, "approved promotion");
    if (!rp.ok) return { ok: false, reason: rp.reason ?? "repoint failed" };
    this.registry.removeCandidate(manifest.seam, moduleId);
    this.log(`modules: ${moduleId} PROMOTED on ${manifest.seam} by ${approver}`);
    return { ok: true, state: "promoted" };
  }

  /** rejected — terminal, keeps evidence. Rollback-side: no approval needed. */
  reject(moduleId: string, actor: string, reason: string): StepResult {
    return this.step(moduleId, ["awaiting_approval"], "rejected", () => {
      const manifest = this.manifestOf(moduleId);
      if (manifest) this.registry.removeCandidate(manifest.seam, moduleId);
      appendGovernanceAudit(this.governanceDir, {
        timestamp: this.now(),
        source: "l4",
        event: "module_rejected",
        refId: moduleId,
        summary: `rejected by ${actor}: ${reason}`,
      });
      return null;
    }, actor, reason);
  }

  /** retired (§8.1): manual demote — one step, instant, no approval
   *  (rollback is always free). Restores builtin on the module's seam. */
  demote(seam: string, actor: string, reason: string): StepResult {
    const active = this.registry.activeFor(seam);
    if (active === "builtin") return { ok: false, reason: `seam ${seam} already on builtin` };
    const rp = this.registry.repoint(seam, "builtin", actor, reason);
    if (!rp.ok) return { ok: false, reason: rp.reason ?? "repoint failed" };
    this.setState(active, "retired");
    this.transition(seam, active, "promoted", "retired", actor, reason);
    return { ok: true, state: "retired" };
  }

  /** withdrawn: housekeeping (§6) — candidates awaiting approval past
   *  30 days are withdrawn with an event. Returns the ids withdrawn. */
  withdrawStale(maxAgeMs = STALE_CANDIDATE_MS): string[] {
    const out: string[] = [];
    for (const seam of Object.keys(this.registry.snapshot().seams)) {
      for (const id of this.registry.candidatesFor(seam)) {
        const env = readEnvelope(id, this.envelopesDir);
        if (!env || env.data.state !== "awaiting_approval") continue;
        const report = env.data.evalReport as ModuleEvalReport | undefined;
        const since = report?.timestamp ?? env.timestamp;
        if (this.now() - since < maxAgeMs) continue;
        this.registry.removeCandidate(seam, id);
        this.setState(id, "withdrawn");
        this.transition(seam, id, "awaiting_approval", "withdrawn", "system", "stale: no approval within 30 days");
        appendGovernanceAudit(this.governanceDir, {
          timestamp: this.now(),
          source: "l4",
          event: "module_withdrawn",
          refId: id,
          summary: `${seam}: candidate withdrawn after 30 days without approval`,
        });
        out.push(id);
      }
    }
    return out;
  }

  // ── Internals ────────────────────────────────────────────────────────

  /** §6.2 — thin FSM over already-collected evidence. `runContract`
   *  enforces I5/I6 and writes exactly one journal row (layer "L4"). */
  private async runL4Contract(
    moduleId: string,
    report: ModuleEvalReport,
    cycleId: string | undefined,
    thresholds: ReturnType<typeof effectiveGates>,
  ): Promise<{ ok: boolean; reason: string }> {
    const passRate =
      report.pairs.length > 0
        ? report.pairs.filter((p) => p.candidateSuccess).length / report.pairs.length
        : 0;
    const ok = async () =>
      ({ ok: true as const, stage: "monitoring" as const, durationMs: 0 });
    const evidence = (pass: boolean, reason: string) => async () =>
      pass
        ? { ok: true as const, stage: "monitoring" as const, durationMs: 0 }
        : { ok: false as const, stage: "monitoring" as const, reason, halt: false, recoverable: true };

    const deps: ContractDeps = {
      staticAnalysis: evidence(true, ""), // wall passed at `sandboxed`
      sandboxApply: evidence(true, ""), // host hello passed at `built`
      tests: evidence(report.tier0Breach === null, report.tier0Breach ?? ""),
      benchmark: async () => ({
        ok: true,
        stage: "benchmark",
        durationMs: 0,
        artifact: {
          stage: "benchmark",
          durationMs: 0,
          data: {
            // Honest components only: accuracy + latency are measured;
            // the other four are not observable in a module eval → 0.
            fitnessVector: {
              accuracy: passRate,
              latency:
                report.latency.incumbentMeanMs > 0
                  ? report.latency.candidateMeanMs / report.latency.incumbentMeanMs
                  : 0,
              cost: 0,
              toolSuccess: 0,
              hallucination: 0,
              userSatisfaction: 0,
            },
            aggregate: passRate,
            samples: report.pairs.map((p) => ({
              candidate: p.candidateSuccess ? 1 : 0,
              baseline: p.incumbentSuccess ? 1 : 0,
            })),
          },
        },
      }),
      safetyChecks: evidence(report.tier0Breach === null, report.tier0Breach ?? ""),
      regression: evidence(
        !report.latency.breached,
        `latency floor breached (${report.latency.candidateMeanMs.toFixed(1)}ms vs ${report.latency.incumbentMeanMs.toFixed(1)}ms incumbent)`,
      ),
      deploy: ok, // promotion itself is human-gated AFTER the FSM (§6.4)
      monitoring: ok,
      assertBudget: () => ({ allow: true, breaches: [], reason: "l4 eval ran inside dream budget" }),
      evaluateConfidence: (samples) => evaluateGate(samples, thresholds),
      writeJournal: (entry) => appendJournal(this.journalPath(), entry),
    };

    const final = await runContract(
      makeInitialState({
        cycleId: cycleId ?? `l4-${moduleId}`,
        candidateId: moduleId,
        layer: "L4",
        budgetCaps: DEFAULT_BUDGET_CAPS,
      }),
      deps,
    );
    const decided = final.decided;
    return decided?.action === "accept"
      ? { ok: true, reason: "contract accepted" }
      : { ok: false, reason: decided?.reason ?? "no decision" };
  }

  private frozenCheck(): { ok: false; reason: string } | null {
    const f = layerFrozen("l4", this.governanceDir);
    return f.frozen ? { ok: false, reason: f.reason } : null;
  }

  /** Shared guard + state write + history row for simple transitions.
   *  `work` returns null on success or a failure reason (→ `failed`). */
  private step(
    moduleId: string,
    fromStates: ModuleState[],
    to: ModuleState,
    work: () => string | null,
    actor = "dream",
    reason = "",
  ): StepResult {
    const frozen = this.frozenCheck();
    if (frozen) return frozen;
    const state = this.stateOf(moduleId);
    if (!state || !fromStates.includes(state)) {
      return { ok: false, reason: `cannot reach ${to} from state ${state ?? "(missing)"}` };
    }
    const seam = this.seamOf(moduleId);
    const failure = work();
    if (failure) {
      this.setState(moduleId, "failed");
      this.transition(seam, moduleId, state, "failed", actor, failure);
      return { ok: false, reason: failure };
    }
    this.setState(moduleId, to);
    this.transition(seam, moduleId, state, to, actor, reason || `${to} ok`);
    return { ok: true, state: to };
  }

  private async stepAsync(
    moduleId: string,
    fromStates: ModuleState[],
    to: ModuleState,
    work: () => Promise<string | null>,
  ): Promise<StepResult> {
    const frozen = this.frozenCheck();
    if (frozen) return frozen;
    const state = this.stateOf(moduleId);
    if (!state || !fromStates.includes(state)) {
      return { ok: false, reason: `cannot reach ${to} from state ${state ?? "(missing)"}` };
    }
    const seam = this.seamOf(moduleId);
    const failure = await work();
    if (failure) {
      this.setState(moduleId, "failed");
      this.transition(seam, moduleId, state, "failed", "dream", failure);
      return { ok: false, reason: failure };
    }
    this.setState(moduleId, to);
    this.transition(seam, moduleId, state, to, "dream", `${to} ok`);
    return { ok: true, state: to };
  }

  private setState(moduleId: string, state: ModuleState): void {
    updateEnvelope(
      moduleId,
      () => this.missingEnvelope(moduleId),
      (env) => ({ ...env, data: { ...env.data, state } }),
      this.envelopesDir,
    );
  }

  private missingEnvelope(moduleId: string): ArtifactEnvelope {
    // Reached only if the envelope vanished mid-lifecycle — rebuild a
    // minimal one rather than crash (evidence loss is logged).
    this.log(`modules: envelope for ${moduleId} missing — rebuilding minimal record`);
    return {
      id: moduleId,
      kind: "module",
      parents: [],
      timestamp: this.now(),
      data: {},
    };
  }

  private seamOf(moduleId: string): string {
    const env = readEnvelope(moduleId, this.envelopesDir);
    const seam = env?.data.seam;
    return typeof seam === "string" ? seam : "(unknown)";
  }

  private parentFor(seam: string): string {
    const active = this.registry.activeFor(seam);
    return active === "builtin" ? `builtin:${seam}` : active;
  }

  private transition(
    seam: string,
    moduleId: string,
    from: string,
    to: string,
    actor: string,
    reason: string,
  ): void {
    this.registry.recordStateTransition(seam, moduleId, from, to, actor, reason);
    this.log(`modules: ${moduleId} ${from} → ${to} (${reason})`);
  }
}
