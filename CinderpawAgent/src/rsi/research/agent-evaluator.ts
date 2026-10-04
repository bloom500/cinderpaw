/**
 * S1.2 of the AgentLoop evolution spec (2026-10-04, §4.3, §4.4, §17): the
 * external evaluator. Given the workspace an executor left behind and the
 * task's `VerifierRef`, it runs the referenced check inside an isolation cell
 * and writes the only score that counts, a `Verdict`.
 *
 * RESEARCH ONLY (spec §4.7). Nothing in `rsi/research/` is wired into a live
 * path; a user install never runs this.
 *
 * Rules this file holds:
 *
 *   1. The checks live here, in a registry the evaluator holds. A task
 *      carries only a reference (`VerifierRef`), so the executor never reads
 *      what it is graded on.
 *   2. Every check runs inside the cell, never on the host. There is no host
 *      fallback: no cell means the run is refused with the cell's reason.
 *   3. The workspace is untrusted, it is what the executor wrote. The cell
 *      uses the plain base image (`image: "base"`), so a `bun.lock` planted
 *      in the workspace is never installed, and paths in a check must stay
 *      inside the workspace.
 *   4. A run that cannot be graded is refused, not failed. A cell that broke
 *      (exit -1 without a timeout: docker itself failed) says nothing about
 *      the executor, so it must not cost the executor a point.
 *   5. `score` is the fraction of sub-checks passed, in [0, 1]. That bound is
 *      per task on purpose (spec §27.2 rule 3): the agent's fitness is the
 *      open ability scale fitted from these verdicts (S1.20), not this number.
 */

import { sha256Canonical } from "../infra/hash-chain.ts";
import type { IsolatedStep, IsolationBackend } from "../l3-code/isolation.ts";
import type { AgentTask } from "./task-family.ts";

export const EVALUATOR_VERSION = "agent-evaluator/1";

export type LeafCheck =
  | { kind: "file_exists"; path: string }
  | { kind: "file_contains"; path: string; text: string }
  | { kind: "command"; argv: string[]; timeoutMs: number };

export type Check = LeafCheck | { kind: "composite"; checks: { id: string; check: LeafCheck }[] };

/** checkId -> check. Held by the evaluator, hashed into every verdict. */
export type CheckRegistry = Readonly<Record<string, Check>>;

export interface Verdict {
  taskId: string;
  executorHash: string;
  evaluatorHash: string;
  /** All sub-checks passed. The primary metric. */
  passed: boolean;
  subChecks: { id: string; passed: boolean }[];
  /** Fraction of sub-checks passed, in [0, 1]. */
  score: number;
}

export type EvaluationResult = { ok: true; verdict: Verdict } | { ok: false; reason: string };

/** Default wall time for a file check: they are one `test` or `grep`. */
const FILE_CHECK_MS = 30_000;

/** A workspace-relative path with no way out: not absolute, no drive, no `..`. */
function insideWorkspace(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || /^[a-zA-Z]:/.test(path)) return false;
  return !path.split("/").includes("..");
}

function leafProblem(id: string, c: LeafCheck): string | null {
  if (c.kind === "file_exists" || c.kind === "file_contains") {
    if (!insideWorkspace(c.path)) return `check ${id}: path "${c.path}" is outside the workspace`;
    if (c.kind === "file_contains" && !c.text) return `check ${id}: file_contains has no text`;
    return null;
  }
  if (c.kind === "command") {
    if (c.argv.length === 0) return `check ${id}: command has no argv`;
    if (!Number.isInteger(c.timeoutMs) || c.timeoutMs <= 0) return `check ${id}: command timeout must be a whole number above 0`;
    return null;
  }
  return `check ${id}: kind "${(c as { kind: string }).kind}" cannot be a sub-check`;
}

function toStep(id: string, c: LeafCheck): IsolatedStep {
  if (c.kind === "file_exists") return { name: id, argv: ["test", "-e", c.path], timeoutMs: FILE_CHECK_MS };
  // -F: the text is literal, not a pattern. --: the text may start with "-".
  if (c.kind === "file_contains") return { name: id, argv: ["grep", "-qF", "--", c.text, c.path], timeoutMs: FILE_CHECK_MS };
  return { name: id, argv: c.argv, timeoutMs: c.timeoutMs };
}

export async function evaluate(args: {
  cell: IsolationBackend;
  task: AgentTask;
  executorHash: string;
  /** Host directory holding the executor's final workspace. Copied into the
   *  cell, never mounted. */
  workspaceDir: string;
  checks: CheckRegistry;
}): Promise<EvaluationResult> {
  const { cell, task, checks } = args;
  const ref = task.verifier;
  const check = checks[ref.checkId];
  if (!check) return { ok: false, reason: `task ${task.id}: no check "${ref.checkId}" in the evaluator registry` };
  if (check.kind !== ref.kind) {
    return { ok: false, reason: `task ${task.id}: references a ${ref.kind} check, the registry holds a ${check.kind}` };
  }

  const leaves = check.kind === "composite" ? check.checks : [{ id: ref.checkId, check }];
  if (leaves.length === 0) return { ok: false, reason: `check ${ref.checkId}: composite has no sub-checks` };
  for (const l of leaves) {
    const problem = leafProblem(l.id, l.check);
    if (problem) return { ok: false, reason: problem };
  }

  const available = await cell.available();
  if (!available.ok) return { ok: false, reason: available.reason };

  const results = await cell.run(
    args.workspaceDir,
    leaves.map((l) => toStep(l.id, l.check)),
    { image: "base" },
  );
  const broken = results.find((r) => r.exitCode === -1 && !r.timedOut);
  if (broken || results.length !== leaves.length) {
    return { ok: false, reason: `the evaluation cell failed, not the task: ${broken?.stderr || "missing results"}` };
  }

  const subChecks = leaves.map((l, i) => ({ id: l.id, passed: results[i]!.exitCode === 0 && !results[i]!.timedOut }));
  const passes = subChecks.filter((s) => s.passed).length;
  return {
    ok: true,
    verdict: {
      taskId: task.id,
      executorHash: args.executorHash,
      evaluatorHash: sha256Canonical({ version: EVALUATOR_VERSION, check }),
      passed: passes === subChecks.length,
      subChecks,
      score: passes / subChecks.length,
    },
  };
}

export interface Canary {
  name: string;
  task: AgentTask;
  workspaceDir: string;
  expect: "pass" | "fail";
}

/** Known-answer tasks run before scoring. Any canary that comes back wrong,
 *  or cannot run, is a problem; the caller refuses the run on a non-empty
 *  list (spec §10, evaluator corruption). */
export async function runCanaries(cell: IsolationBackend, checks: CheckRegistry, canaries: readonly Canary[]): Promise<string[]> {
  const problems: string[] = [];
  for (const c of canaries) {
    const r = await evaluate({ cell, task: c.task, executorHash: "canary", workspaceDir: c.workspaceDir, checks });
    if (!r.ok) problems.push(`canary ${c.name} could not run: ${r.reason}`);
    else if (r.verdict.passed !== (c.expect === "pass")) {
      problems.push(`canary ${c.name} should ${c.expect} but ${r.verdict.passed ? "passed" : "failed"}: the evaluator is broken`);
    }
  }
  return problems;
}
