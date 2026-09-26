/**
 * Faza 2 Slice 4 — the code-RSI runner: threading, in one seam.
 * Spec: `docs/superpowers/specs/2026-07-01-faza2-code-rsi-design.md`.
 *
 * `runCodeCandidate` drives ONE code candidate through the same Evolution
 * Contract FSM the config path uses — same runner, same per-candidate
 * Journal row (layer "L2"), same budget precheck — with the code-aware
 * leaves from `code-leaves.ts`. `makeCodeStageAdapters` binds those
 * leaves' primitives to the Rust bridge (protocol a) + the Slice 2
 * worktree runner, mirroring `adapters.ts` discipline.
 *
 * What promotion means here (IMPORTANT): the candidate's CodeGenome —
 * patch text included — is committed to the git SUBSTRATE and recorded on
 * `code-main`, and it joins the approval queue. The live source tree is
 * NEVER touched: applying a promoted patch to the running agent stays
 * behind the Slice 5 approval gate (first 10 patches need explicit UI
 * approval per spec §2.5). Until then a promoted code genome is a
 * receipt: "this patch exists, applied cleanly, and did no worse than its
 * unpatched base on tests, tsc and build, measured in the same sandbox."
 *
 * This file is on the patch DENYLIST (it wires the walls together).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RsiBridge } from "../infra/bridge.ts";
import type { CodeGenome } from "./code-genome.ts";
import { isDiffParseError, parseUnifiedDiff, validateCodePatch } from "./code-genome.ts";
import type { CodeEvalMeasurements, CodeEvalResult } from "./code-sandbox.ts";
import { evaluateCodePatch, type CodeSandboxOptions } from "./code-sandbox.ts";
import { bunExec } from "./code-sandbox.ts";
import { DockerIsolation } from "./isolation.ts";
import {
  codeGateBypass,
  contractLeavesForCodePatch,
  type CodeCandidateRun,
  type CodeStageDeps,
} from "./code-leaves.ts";
import { contractDepsFrom } from "../infra/contract-deps.ts";
import { runContract } from "../infra/contract-runner.ts";
import { makeInitialState, type ContractState } from "../infra/contract.ts";
import { DEFAULT_BUDGET_CAPS } from "../infra/budget.ts";
import type { PopulationManager } from "../l1-config/population-manager.ts";
import type { PendingPatchStore } from "./pending-patches.ts";

/** Same safety-net timeout as `adapters.ts` — a lost bridge line must
 *  free the slot, not hang the candidate forever. */
const BRIDGE_TIMEOUT_MS = 30_000;

/** At most this many patches wait for a person at once. Past it the round
 *  does not propose: a queue nobody gets through is noise, and every round
 *  costs a proposal and a sandbox run. */
export const MAX_PENDING_CODE_PATCHES = 5;

/** Base measurements by repo, base commit and host bun: the sandbox image
 *  is built from the base's lockfile on `oven/bun:<host version>`, so the
 *  base runs once until an approved patch moves HEAD. A run the sandbox
 *  killed is not kept, nor is a failed one.
 *  ponytail: in memory, so one base run per restart; persist it if that
 *  ever shows up as a cost. */
const baseRuns = new Map<string, Promise<CodeEvalResult>>();

/** Measurements as the Rust side reads them (snake_case, like every
 *  bridge payload). */
function toWire(m: CodeEvalMeasurements) {
  return {
    tests_passed: m.testsPassed,
    tests_failed: m.testsFailed,
    tests_exit_code: m.testsExitCode,
    tsc_exit_code: m.tscExitCode,
    build_exit_code: m.buildExitCode,
    changed_lines: m.changedLines,
  };
}

/**
 * Bind the code leaves' primitives to the production surfaces: the Rust
 * bridge (wall / scorer / commit / ratchet — snake_case wire, like every
 * bridge payload) and the Slice 2 disposable-worktree runner.
 */
export function makeCodeStageAdapters(args: {
  bridge: RsiBridge;
  /** Root of the git repo worktrees are cut from (the source monorepo).
   *  Code-RSI only runs where the agent's own sources exist. */
  repoRoot: string;
  sandbox?: Omit<CodeSandboxOptions, "repoRoot">;
  log?: (line: string) => void;
}): CodeStageDeps {
  const { bridge, repoRoot } = args;
  const sandbox = (): CodeSandboxOptions => ({
    repoRoot,
    scratchDir: join(tmpdir(), "cinderpaw-code-rsi"),
    // The cell the candidate runs in. Docker is the only backend today;
    // without it the candidate is refused with the reason on the card.
    isolation: new DockerIsolation({ exec: bunExec, log: args.log ?? (() => {}) }),
    ...args.sandbox,
  });
  return {
    validatePatch: async (patch) => {
      // TS wall first (parse + policy, in-process): cheap rejections never
      // cross the bridge. Then the Rust wall — the one compiled into the
      // binary — has the final word. Both must pass.
      const parsed = parseUnifiedDiff(patch);
      if (isDiffParseError(parsed)) return { ok: false, reason: `parse: ${parsed.error}` };
      const ts = validateCodePatch(parsed);
      if (!ts.ok) return { ok: false, reason: ts.reason };

      const v = await bridge.request<{ ok: boolean; reason?: string }>(
        "rsi_validate_code_patch",
        { patch },
        BRIDGE_TIMEOUT_MS,
      );
      return { ok: v.ok, ...(v.reason ? { reason: v.reason } : {}) };
    },

    evaluateInWorktree: (genome) => evaluateCodePatch(genome, sandbox()),

    measureBase: (baseCommit) => {
      const key = `${repoRoot}\0${baseCommit}\0${Bun.version}`;
      let run = baseRuns.get(key);
      if (!run) {
        run = evaluateCodePatch({ patch: null, baseCommit }, sandbox());
        baseRuns.set(key, run);
        const forget = () => baseRuns.delete(key);
        run.then((r) => { if (!r.ok || r.measurements.testsExitCode < 0) forget(); }, forget);
      }
      return run;
    },

    judgePatch: async (base, candidate) => {
      const j = await bridge.request<{
        candidate: { score: number };
        base: { score: number };
        tests: string | null;
        tsc: string | null;
        build: string | null;
        no_worse: boolean;
      }>("rsi_judge_code_patch", { base: toWire(base), candidate: toWire(candidate) }, BRIDGE_TIMEOUT_MS);
      return {
        score: j.candidate.score,
        baseScore: j.base.score,
        tests: j.tests ?? null,
        tsc: j.tsc ?? null,
        build: j.build ?? null,
        noWorse: j.no_worse,
      };
    },

    commitCodePatch: async ({ genomeId, genome, score }) => {
      const shortId = genomeId.replace(/-/g, "").slice(0, 8);
      const r = await bridge.request<{ commitHash: string }>(
        "rsi_commit_code_patch",
        {
          genome_id: genomeId,
          patch: genome.patch,
          // The FULL CodeGenome (patch + provenance) is the substrate
          // snapshot — an audit can reconstruct exactly what was judged.
          genome_json: JSON.stringify(genome),
          candidate_branch: `code-${shortId}`,
          metadata: {
            score,
            strategy: "code-rsi",
            parent_lineage: [],
            mutation_type: "code_patch",
            cost_tokens: 0,
            duration_ms: 0,
          },
        },
        BRIDGE_TIMEOUT_MS,
      );
      return { commitHash: r.commitHash };
    },

    ratchetAttempt: async (commitHash, _score) => {
      const r = await bridge.request<{
        advanced: boolean;
        prior_score: number | null;
        candidate_score: number;
      }>("rsi_ratchet_attempt", { candidate_commit: commitHash }, BRIDGE_TIMEOUT_MS);
      // Same shape as the L1 adapter in infra/adapters.ts, deliberately: this
      // is a second copy of the same wire mapping, and the first copy dropped
      // `candidate_score` — the only number the ratchet actually compares.
      return {
        advanced: r.advanced,
        previousBest: r.prior_score ?? 0,
        candidateScore: r.candidate_score,
        hadPrior: r.prior_score !== null && r.prior_score !== undefined,
      };
    },
  };
}

export interface CodeCandidateArgs {
  genomeId: string;
  genome: CodeGenome;
  deps: CodeStageDeps;
  /** When supplied, the candidate is registered in the shared population
   *  (spec §5.2: one population) with mutationType "code_patch". */
  pop?: PopulationManager;
  /** Journal linkage — same knobs as `RatchetDeps`. */
  cycleId?: string;
  journalPath?: () => string;
  /** Slice 5: when supplied, every candidate the contract accepts (no
   *  worse than its base) is queued for the approval gate (live apply
   *  NEVER happens here — see `pending-patches.ts`). */
  pendingStore?: PendingPatchStore;
}

export interface CodeCandidateResult {
  /** The contract's terminal verdict (accept / reject / halt + reason). */
  decided: ContractState["decided"];
  /** True iff the patch was recorded on `code-main`. */
  advanced: boolean;
  commitHash?: string;
  /** The Rust composite score, when the benchmark stage was reached. */
  score?: number;
  /** What the unpatched base scored: `score - previousBest` is the
   *  observed effect the self-model records. */
  previousBest?: number;
  measurements?: CodeEvalMeasurements;
}

/**
 * Run one code candidate through the full contract. Never throws for a
 * candidate-caused failure — the FSM turns those into reject/halt
 * verdicts with a Journal row; only wiring bugs escape.
 */
export async function runCodeCandidate(args: CodeCandidateArgs): Promise<CodeCandidateResult> {
  if (args.pop) {
    args.pop.add({
      id: args.genomeId,
      generation: 0,
      lineage: [],
      code: args.genome,
      mutationType: "code_patch",
    });
  }

  const run: CodeCandidateRun = {};
  const leaves = contractLeavesForCodePatch(args.deps, args.genome, args.genomeId, run);
  const contractDeps = contractDepsFrom(leaves, {
    evaluateConfidence: codeGateBypass(),
    ...(args.journalPath ? { journalPath: args.journalPath } : {}),
  });

  const final = await runContract(
    makeInitialState({
      cycleId: args.cycleId ?? "c-code-live",
      candidateId: args.genomeId,
      layer: "L2", // Code Evolution (BRSI §5)
      budgetCaps: DEFAULT_BUDGET_CAPS,
    }),
    contractDeps,
  );

  if (args.pop && run.commitHash) {
    args.pop.setCommitHash(args.genomeId, run.commitHash);
  }

  // No worse than its base, and recorded: queue it for the human gate.
  if (args.pendingStore && final.decided?.action === "accept" && run.commitHash && run.score !== undefined) {
    args.pendingStore.add({
      id: args.genomeId,
      genome: args.genome,
      score: run.score,
      commitHash: run.commitHash,
    });
  }

  return {
    decided: final.decided,
    advanced: run.advanced === true,
    ...(run.commitHash ? { commitHash: run.commitHash } : {}),
    ...(run.score !== undefined ? { score: run.score } : {}),
    ...(run.previousBest !== undefined ? { previousBest: run.previousBest } : {}),
    ...(run.measurements ? { measurements: run.measurements } : {}),
  };
}
