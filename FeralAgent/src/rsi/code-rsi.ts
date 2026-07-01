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
 * patch text included — is committed to the git SUBSTRATE and the
 * strict-greater ratchet moves the champion pointer. The live source
 * tree is NEVER touched: applying a promoted patch to the running agent
 * stays behind the Slice 5 approval gate (first 10 patches need explicit
 * UI approval per spec §2.5). Until then a promoted code genome is a
 * receipt: "this patch exists, applied cleanly, kept 100% of the suite
 * green, type-checked, built, and out-scored the incumbent."
 *
 * This file is on the patch DENYLIST (it wires the walls together).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RsiBridge } from "./bridge.ts";
import type { CodeGenome } from "./code-genome.ts";
import { isDiffParseError, parseUnifiedDiff, validateCodePatch } from "./code-genome.ts";
import type { CodeEvalMeasurements } from "./code-sandbox.ts";
import { evaluateCodePatch, type CodeSandboxOptions } from "./code-sandbox.ts";
import {
  codeGateBypass,
  contractLeavesForCodePatch,
  type CodeCandidateRun,
  type CodeStageDeps,
} from "./code-leaves.ts";
import { contractDepsFrom } from "./contract-deps.ts";
import { runContract } from "./contract-runner.ts";
import { makeInitialState, type ContractState } from "./contract.ts";
import { DEFAULT_BUDGET_CAPS } from "./budget.ts";
import type { PopulationManager } from "./population-manager.ts";

/** Same safety-net timeout as `adapters.ts` — a lost bridge line must
 *  free the slot, not hang the candidate forever. */
const BRIDGE_TIMEOUT_MS = 30_000;

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
}): CodeStageDeps {
  const { bridge, repoRoot } = args;
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

    evaluateInWorktree: (genome) =>
      evaluateCodePatch(genome, {
        repoRoot,
        scratchDir: join(tmpdir(), "feral-code-rsi"),
        ...args.sandbox,
      }),

    scorePatch: async (m: CodeEvalMeasurements) => {
      const scored = await bridge.request<{ score: number }>(
        "rsi_score_code_patch",
        {
          measurements: {
            tests_passed: m.testsPassed,
            tests_failed: m.testsFailed,
            tests_exit_code: m.testsExitCode,
            tsc_exit_code: m.tscExitCode,
            build_exit_code: m.buildExitCode,
            changed_lines: m.changedLines,
          },
        },
        BRIDGE_TIMEOUT_MS,
      );
      return { score: scored.score };
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
      }>("rsi_ratchet_attempt", { candidate_commit: commitHash }, BRIDGE_TIMEOUT_MS);
      return { advanced: r.advanced, previousBest: r.prior_score ?? 0 };
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
}

export interface CodeCandidateResult {
  /** The contract's terminal verdict (accept / reject / halt + reason). */
  decided: ContractState["decided"];
  /** True iff the Rust ratchet advanced the champion pointer. */
  advanced: boolean;
  commitHash?: string;
  /** The Rust composite score, when the benchmark stage was reached. */
  score?: number;
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

  return {
    decided: final.decided,
    advanced: run.advanced === true,
    ...(run.commitHash ? { commitHash: run.commitHash } : {}),
    ...(run.score !== undefined ? { score: run.score } : {}),
    ...(run.measurements ? { measurements: run.measurements } : {}),
  };
}
