/**
 * S1.9 of the AgentLoop evolution spec (2026-10-04, §4.2 steps 3-4, §17):
 * the feasibility check. A proposed task is built only after the gate let
 * it through, and kept only if, in a cell, its check passes the example
 * solution and fails the starting workspace and every failure case. A check
 * that passes everything or nothing teaches nothing and is discarded,
 * without trusting the proposer's word about its own task.
 *
 * RESEARCH ONLY (spec §4.7).
 *
 * Rules this file holds:
 *   1. Only a `GatedProposal` can be checked or materialized, and only
 *      `admit` makes one, from an allowed gate verdict. A cast does not
 *      help: the runtime set of admitted proposals is checked too.
 *   2. The check never enters the workspace: it travels in the argv and
 *      runs from /tmp (a fresh tmpfs), so a bunfig.toml or .env the
 *      proposal planted among its files is never loaded (same rule as F1).
 *   3. A cell that broke says nothing about the task: it is reported as a
 *      cell failure, not as an infeasible task.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Canonical } from "../infra/hash-chain.ts";
import type { IsolationBackend } from "../l3-code/isolation.ts";
import type { CheckRegistry } from "./agent-evaluator.ts";
import type { GateVerdict } from "./domain-gate.ts";
import { writeRepo } from "./families/build-repair.ts";
import type { AgentTask, TaskBudget } from "./task-family.ts";

/** A task in the Code-as-Task shape (spec §4.2 step 2). */
export interface TaskProposal {
  /** What the executor will read. */
  instruction: string;
  /** The starting workspace: path -> text. */
  files: Record<string, string>;
  /** A Bun program; `process.argv[1]` is the workspace directory; exit 0 = pass. */
  check: string;
  /** Files that, laid over `files`, make a correct answer. */
  solution: Record<string, string>;
  /** At least two wrong answers, each laid over `files`. */
  failures: Record<string, string>[];
}

declare const gated: unique symbol;
/** A proposal the gate allowed. Only `admit` returns one. */
export type GatedProposal = TaskProposal & { readonly [gated]: true; readonly gate: GateVerdict };

const admitted = new WeakSet<object>();

export function admit(p: TaskProposal, verdict: GateVerdict): GatedProposal | null {
  if (!verdict.allowed) return null;
  const g = { ...p, gate: verdict } as GatedProposal;
  admitted.add(g);
  return g;
}

const CHECK_MS = 30_000;

/** The argv the cell runs: from /tmp, the check in the argv (rule 2). */
export const checkArgv = (check: string): string[] => ["sh", "-c", 'cd /tmp && exec bun -e "$0" "$1"', check, "/app/work"];

export type Feasibility = { ok: true } | { ok: false; kind: "infeasible" | "cell"; reason: string };

export async function checkFeasibility(p: GatedProposal, cell: IsolationBackend): Promise<Feasibility> {
  if (!admitted.has(p)) throw new Error("this proposal did not pass the gate; it cannot be checked or built");
  const available = await cell.available();
  if (!available.ok) return { ok: false, kind: "cell", reason: available.reason };

  /** Does the check pass on `files` with `over` laid on top? */
  const passes = async (over: Record<string, string>): Promise<boolean | string> => {
    const dir = mkdtempSync(join(tmpdir(), "cp-feas-"));
    try {
      writeRepo({ ...p.files, ...over }, dir);
      const [r] = await cell.run(dir, [{ name: "check", argv: checkArgv(p.check), timeoutMs: CHECK_MS }], { image: "base" });
      if (!r || (r.exitCode === -1 && !r.timedOut)) return `the cell failed, not the task: ${r?.stderr || "no result"}`;
      return r.exitCode === 0 && !r.timedOut;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const solved = await passes(p.solution);
  if (typeof solved === "string") return { ok: false, kind: "cell", reason: solved };
  if (!solved) return { ok: false, kind: "infeasible", reason: "the check never passes: the example solution fails it" };
  const start = await passes({});
  if (typeof start === "string") return { ok: false, kind: "cell", reason: start };
  if (start) return { ok: false, kind: "infeasible", reason: "the check always passes: the starting workspace already passes it" };
  for (const [i, f] of p.failures.entries()) {
    const r = await passes(f);
    if (typeof r === "string") return { ok: false, kind: "cell", reason: r };
    if (r) return { ok: false, kind: "infeasible", reason: `the check cannot tell right from wrong: failure case ${i + 1} passes` };
  }
  return { ok: true };
}

/** A feasible proposal as an `AgentTask`, its starting files and its check. */
export function materialize(
  p: GatedProposal,
  origin: { source: string; family: string; fieldTaskId: string; language: string },
  budget: TaskBudget,
): { task: AgentTask; repo: Record<string, string>; checks: CheckRegistry } {
  if (!admitted.has(p)) throw new Error("this proposal did not pass the gate; it cannot be checked or built");
  const id = `proposed/${origin.source}/${origin.fieldTaskId}/${origin.language}/${sha256Canonical(p).slice(0, 12)}`;
  const task: AgentTask = {
    id,
    familyId: "open-engine",
    templateId: `${origin.source}:${origin.family}`,
    seed: 0,
    instruction: p.instruction,
    workspaceImage: sha256Canonical(p.files),
    budget,
    verifier: { kind: "command", checkId: id },
  };
  return { task, repo: p.files, checks: { [id]: { kind: "command", argv: checkArgv(p.check), timeoutMs: CHECK_MS } } };
}
