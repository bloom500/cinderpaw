/**
 * The skill library (competence plan §3.1): expensive solving becomes cheap
 * procedure, with its conditions attached.
 *
 * `skill-induction.ts` next door turns a verified ARC program into a tool.
 * This file is the same idea for the rest of digital work, where a skill is
 * not a program but a PROCEDURE: the ordered steps that solved a family of
 * tasks, and the conditions under which they did. Astra's example: "automate
 * the export" is reusable only if it keeps the app version, the rights
 * needed, the result format and how to verify. Here those are `conditions`,
 * and a procedure without them is refused, the way `skill-induction.ts`
 * refuses a program without evidence.
 *
 * Where a skill comes from: receipts. `induceProcedure` takes the receipts
 * written under ONE condition (`Attempt.condition`), finds the step that
 * was verified there, and checks it against held-out receipts of the same
 * condition before it becomes a skill. Failing the held-out check is a
 * result to keep, never a skill to reuse; same rule as next door.
 *
 * What it is for: an agent that meets a failure it has seen before should
 * not explore again. `lookup(condition)` gives it the procedure first, at
 * the cost of one attempt instead of a search. Astra's metric, cost per
 * verified task including the failures, is what the campaign measures with
 * and without this library (arm `skilled` in `infra/arms.ts`).
 *
 * Storage: append-only JSONL, one skill per line, deduplicated by content
 * hash, corrupt lines skipped. Retirement is a new line with `retired`,
 * never a deletion: the history of what was believed stays (plan §2.5).
 */

import fs from "node:fs";
import path from "node:path";
import { cinderpawHome } from "../../config.ts";
import type { Attempt } from "../../rsi/l3-code/experiment-selector.ts";

/** The conditions a procedure holds under. Every field is a claim the
 *  receipts support, not a wish. */
export interface SkillConditions {
  /** The receipt condition this was induced from (a failure signature, a
   *  task family). Exact match on lookup; no fuzzy generalisation here. */
  condition: string;
  /** Tools the procedure needs; a host without them cannot run it. */
  requiresTools: string[];
  /** How the result is checked: the verifier's name, so a skill is never
   *  "done" by its own say-so. */
  verifiedBy: string;
}

export interface LearnedProcedure {
  /** Content hash of (condition, steps). */
  id: string;
  /** Human name, usable as a tool name. */
  name: string;
  /** The ordered steps: for the campaign, repair ids; for the live agent,
   *  tool names with fixed arguments. Data, never code. */
  steps: Array<{ tool: string; args?: Record<string, unknown> }>;
  conditions: SkillConditions;
  /** Receipt ids (`receiptId`) that support this procedure, and the
   *  held-out ones it was checked against. Auditability: "on what
   *  observation does the competence you claim rest?" */
  evidence: { supporting: string[]; heldOut: string[]; heldOutPassed: boolean };
  /** Mean attempts the family cost BEFORE the skill, from its receipts;
   *  the skill costs one. The saving is the reason it exists. */
  costBefore: number;
  inducedAt: number;
  methodVersion: string;
  /** A later line with the same id and `retired` set supersedes it. */
  retired?: { at: number; reason: string; byReceipt?: string };
}

export function defaultSkillLibraryPath(): string {
  return path.join(cinderpawHome(), "agent", "skills", "learned.jsonl");
}

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const receiptIdOf = (a: Attempt) => `${a.file}@${a.ts}`;

export interface InduceOptions {
  /** Receipts under ONE condition, the ones the procedure may learn from. */
  train: Attempt[];
  /** Receipts under the SAME condition the procedure never saw. Required:
   *  a skill checked against nothing is a fit, not a skill. */
  heldOut: Attempt[];
  requiresTools?: string[];
  verifiedBy: string;
  methodVersion: string;
  now?: number;
}

/**
 * From the receipts of one condition, the step that was verified there.
 * Returns null, with the reason, when nothing qualifies:
 *   - no accepted receipt in `train` (nothing was ever verified here);
 *   - the held-out receipts do not show the same step verified (the step
 *     fit the training tasks and no others);
 *   - the receipts disagree on the condition (a caller bug, said loudly).
 */
export function induceProcedure(
  opts: InduceOptions,
): { skill: LearnedProcedure } | { skill: null; reason: string } {
  const all = [...opts.train, ...opts.heldOut];
  const conditions = new Set(all.map((a) => a.condition));
  if (conditions.size !== 1 || all[0]?.condition === undefined) {
    return { skill: null, reason: `receipts must share one condition; got ${[...conditions].join(", ") || "none"}` };
  }
  const condition = all[0].condition;
  if (opts.heldOut.length === 0) return { skill: null, reason: "no held-out receipts: a skill checked against nothing is a fit" };

  // The step: the tool (receipt `file`) accepted most often in training.
  const accepts = new Map<string, Attempt[]>();
  for (const a of opts.train) if (a.verdict === "accept") accepts.set(a.file, [...(accepts.get(a.file) ?? []), a]);
  if (accepts.size === 0) return { skill: null, reason: "nothing was verified under this condition" };
  const [step, supporting] = [...accepts.entries()].sort((x, y) => y[1].length - x[1].length)[0]!;

  // Held out: the same step must have been verified there too, and never
  // refused there. One refusal on held-out is a counterexample.
  const heldOutOnStep = opts.heldOut.filter((a) => a.file === step);
  const passed = heldOutOnStep.length > 0 && heldOutOnStep.every((a) => a.verdict === "accept");
  if (!passed) {
    return {
      skill: null,
      reason: heldOutOnStep.length === 0 ? `held-out receipts never tried "${step}"` : `"${step}" was refused on a held-out task`,
    };
  }

  // Cost before: attempts per task in training, tasks grouped by ts order
  // between accepts (each accept closes a task).
  const perTask: number[] = [];
  let n = 0;
  for (const a of [...opts.train].sort((x, y) => x.ts - y.ts)) {
    n++;
    if (a.verdict === "accept") {
      perTask.push(n);
      n = 0;
    }
  }
  const costBefore = perTask.length ? perTask.reduce((s, c) => s + c, 0) / perTask.length : opts.train.length;

  const id = `proc-${fnv1a32(`${condition}::${step}`)}`;
  return {
    skill: {
      id,
      name: step,
      // A run receipt's step is a tool sequence joined with ">"; an L3 step
      // is one file and has none, so it stays one step.
      steps: step.split(">").map((tool) => ({ tool })),
      conditions: { condition, requiresTools: opts.requiresTools ?? [step], verifiedBy: opts.verifiedBy },
      evidence: {
        supporting: supporting.map(receiptIdOf),
        heldOut: heldOutOnStep.map(receiptIdOf),
        heldOutPassed: true,
      },
      costBefore,
      inducedAt: opts.now ?? Date.now(),
      methodVersion: opts.methodVersion,
    },
  };
}

/** Append-only store. The in-memory view is "last line per id wins", so a
 *  retirement line hides the skill from lookup without deleting it. */
export class SkillLibrary {
  #byId = new Map<string, LearnedProcedure>();

  constructor(private readonly file?: string) {
    if (!file || !fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as LearnedProcedure;
        if (typeof s.id === "string" && s.conditions?.condition !== undefined) this.#byId.set(s.id, s);
      } catch {
        // torn line: skipped, never thrown
      }
    }
  }

  #write(s: LearnedProcedure): void {
    this.#byId.set(s.id, s);
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(s) + "\n");
  }

  /** Add a skill. Same id already known and not retired: nothing written. */
  add(s: LearnedProcedure): { added: boolean } {
    const existing = this.#byId.get(s.id);
    if (existing && !existing.retired) return { added: false };
    this.#write(s);
    return { added: true };
  }

  /** The live procedure for a condition, or null. Exact match. */
  lookup(condition: string): LearnedProcedure | null {
    for (const s of this.#byId.values()) if (!s.retired && s.conditions.condition === condition) return s;
    return null;
  }

  /** Retire a skill: a counterexample arrived (plan §2.5, the same rule as
   *  receipts). The line is appended; the history keeps the skill. */
  retire(id: string, reason: string, byReceipt?: string, now = Date.now()): boolean {
    const s = this.#byId.get(id);
    if (!s || s.retired) return false;
    this.#write({ ...s, retired: { at: now, reason, ...(byReceipt ? { byReceipt } : {}) } });
    return true;
  }

  list(): LearnedProcedure[] {
    return [...this.#byId.values()];
  }
}

/**
 * Induce one procedure per condition from a set of receipts. The receipts
 * of each condition are split by time: the last third is held out, so a
 * step that only worked on the tasks it was fitted to is refused the way
 * `induceProcedure` refuses it. Returns how many were added. Was the
 * campaign arm's (`rsi/infra/arms.ts`); the live run receipts use it too.
 */
export function induceFromReceipts(
  receipts: Attempt[],
  library: SkillLibrary,
  opts: { verifiedBy: string; methodVersion: string } = { verifiedBy: "checkRepo", methodVersion: "m0.2" },
): number {
  const byCondition = new Map<string, Attempt[]>();
  for (const r of receipts) if (r.condition) byCondition.set(r.condition, [...(byCondition.get(r.condition) ?? []), r]);
  let induced = 0;
  for (const rows of byCondition.values()) {
    const sorted = [...rows].sort((x, y) => x.ts - y.ts);
    const cut = Math.max(1, Math.floor((sorted.length * 2) / 3));
    const out = induceProcedure({
      train: sorted.slice(0, cut),
      heldOut: sorted.slice(cut),
      verifiedBy: opts.verifiedBy,
      methodVersion: opts.methodVersion,
    });
    if (out.skill && library.add(out.skill).added) induced++;
  }
  return induced;
}
