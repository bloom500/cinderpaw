/**
 * S1.1 of the AgentLoop evolution spec (2026-10-04, §3.2, §17): the task
 * family contract. Pure types, validation, partitioning and hashing. Nothing
 * here executes a task, calls a model or spends money.
 *
 * RESEARCH ONLY. This directory is the research harness that grows beside the
 * live engine (spec §13). A user install never proposes or executes these
 * tasks; do not wire anything in `rsi/research/` into the dream cycle, the
 * champion projection or any live path (spec §4.7).
 *
 * Three rules this file holds:
 *
 *   1. Partitions hold out WHOLE templates (same rule as `fixtures.ts`): a
 *      template sits in exactly one partition, so every seed of it lands in
 *      the same place and a near-duplicate cannot straddle two partitions.
 *      Retention and anchor sets are not partitions; they are task-id sets
 *      (spec §26, H19) and live elsewhere.
 *   2. One budget per family, frozen in the manifest (spec §26, H20). A task
 *      carrying any other budget is refused, so no field or seed gets more
 *      room than its siblings. The difficulty-band key arrives with S1.18.
 *   3. Only `developmentTasks()` makes a `DevelopmentTask`. Whatever the
 *      evolver may later read (`EvolverInput`) takes that type, so a final or
 *      transfer task is a compile error there, not a review comment.
 */

import type { Partition } from "../infra/campaign.ts";
import { sha256Canonical } from "../infra/hash-chain.ts";

export const TASK_FAMILY_SCHEMA = 1;

/** Same names and order as `campaign.ts`. */
export const PARTITIONS: readonly Partition[] = ["development", "promotion", "final", "transfer"];

/** Hard ceilings for one task. Tokens and dollars are enforced by the broker,
 *  tool calls by the orchestrator, wall time by killing the cell (spec §4.4).
 *  `maxUsd` 0 means stub model only, the same default as the campaign cap. */
export interface TaskBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxWallMs: number;
  maxUsd: number;
}

export type VerifierKind = "file_exists" | "file_contains" | "command" | "composite";
const VERIFIER_KINDS: readonly VerifierKind[] = ["file_exists", "file_contains", "command", "composite"];

/** A pointer to a check held by the evaluator. The check itself never travels
 *  with the task, so the executor cannot read what it will be graded on. */
export interface VerifierRef {
  kind: VerifierKind;
  checkId: string;
}

export interface TaskFamily {
  schemaVersion: typeof TASK_FAMILY_SCHEMA;
  id: string;
  version: string;
  templates: readonly string[];
  /** Template ids per partition. Data, not a function, so it hashes. */
  partitions: Readonly<Record<Partition, readonly string[]>>;
  budget: TaskBudget;
}

export interface AgentTask {
  id: string;
  familyId: string;
  templateId: string;
  seed: number;
  /** What the executor sees. */
  instruction: string;
  /** Content hash of the starting files. */
  workspaceImage: string;
  budget: TaskBudget;
  verifier: VerifierRef;
}

declare const developmentOnly: unique symbol;
/** A task proven to come from the development partition. */
export type DevelopmentTask = AgentTask & { readonly [developmentOnly]: true };

/** Reasons the budget is unusable; empty means valid. */
export function validateBudget(b: TaskBudget): string[] {
  const out: string[] = [];
  for (const key of ["maxInputTokens", "maxOutputTokens", "maxToolCalls", "maxWallMs"] as const) {
    if (!Number.isInteger(b[key]) || b[key] <= 0) out.push(`budget.${key} must be a whole number above 0, got ${b[key]}`);
  }
  if (!Number.isFinite(b.maxUsd) || b.maxUsd < 0) out.push(`budget.maxUsd must be a finite number of 0 or more, got ${b.maxUsd}`);
  return out;
}

/** Reasons the family is unusable; empty means valid. */
export function validateFamily(f: TaskFamily): string[] {
  const out: string[] = [];
  if (f.schemaVersion !== TASK_FAMILY_SCHEMA) out.push(`schemaVersion ${f.schemaVersion} is not ${TASK_FAMILY_SCHEMA}`);
  if (!f.id) out.push("family id is empty");
  if (!f.version) out.push("family version is empty");
  if (f.templates.length === 0) out.push("family has no templates");

  const known = new Set<string>();
  for (const t of f.templates) {
    if (known.has(t)) out.push(`template "${t}" is listed twice`);
    known.add(t);
  }

  const placedIn = new Map<string, Partition>();
  for (const part of PARTITIONS) {
    for (const t of f.partitions[part] ?? []) {
      if (!known.has(t)) out.push(`partition ${part} names unknown template "${t}"`);
      const first = placedIn.get(t);
      if (first) out.push(`template "${t}" is in both ${first} and ${part}`);
      else placedIn.set(t, part);
    }
  }
  for (const t of known) if (!placedIn.has(t)) out.push(`template "${t}" is in no partition`);
  if ((f.partitions.development ?? []).length === 0) out.push("development partition is empty");

  out.push(...validateBudget(f.budget));
  return out;
}

/** The partition a template belongs to. Throws for a template the family
 *  does not place, so a typo is never silently "development". */
export function partitionOf(f: TaskFamily, templateId: string): Partition {
  for (const part of PARTITIONS) if (f.partitions[part].includes(templateId)) return part;
  throw new Error(`template "${templateId}" is not in any partition of family ${f.id}`);
}

/** Reasons the task does not belong to this family; empty means valid. */
export function validateTask(t: AgentTask, f: TaskFamily): string[] {
  const out: string[] = [];
  if (!t.id) out.push("task id is empty");
  if (t.familyId !== f.id) out.push(`task ${t.id} names family "${t.familyId}", not "${f.id}"`);
  if (!f.templates.includes(t.templateId)) out.push(`task ${t.id} names unknown template "${t.templateId}"`);
  if (!Number.isInteger(t.seed)) out.push(`task ${t.id} seed must be a whole number, got ${t.seed}`);
  if (!t.instruction.trim()) out.push(`task ${t.id} has no instruction`);
  if (!t.workspaceImage) out.push(`task ${t.id} has no workspace image hash`);
  if (!VERIFIER_KINDS.includes(t.verifier.kind)) out.push(`task ${t.id} verifier kind "${t.verifier.kind}" is unknown`);
  if (!t.verifier.checkId) out.push(`task ${t.id} verifier has no check id`);
  if (sha256Canonical(t.budget) !== sha256Canonical(f.budget)) out.push(`task ${t.id} budget differs from the family budget`);
  return out;
}

/** The only way to make a `DevelopmentTask`. Tasks of every other partition
 *  are dropped, never converted. */
export function developmentTasks(tasks: readonly AgentTask[], f: TaskFamily): DevelopmentTask[] {
  return tasks.filter((t) => t.familyId === f.id && partitionOf(f, t.templateId) === "development") as DevelopmentTask[];
}

export const familyHash = (f: TaskFamily): string => sha256Canonical(f);
export const taskHash = (t: AgentTask): string => sha256Canonical(t);
