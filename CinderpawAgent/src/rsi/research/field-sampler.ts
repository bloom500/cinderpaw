/**
 * S1.7 of the AgentLoop evolution spec (2026-10-04, §4.2, §4.8, §5, §17):
 * the field sampler. Draws one (occupation, task statement) from the O*NET
 * extract, weighted toward the occupation families the archive has covered
 * least, after the blocklist has removed every excluded one.
 *
 * RESEARCH ONLY (spec §4.7). A user install never proposes or runs tasks
 * from this; only a campaign Darius starts, with a cap, ever reads it.
 *
 * Rules this file holds:
 *
 *   1. The blocklist runs before anything is weighted or drawn (§4.8 layer
 *      1). A blocked family, occupation or term never reaches a draw.
 *   2. Families are the unit of holdout (§5): each family sits in exactly
 *      one partition, and a draw for one partition never returns a task of
 *      another. A plan that breaks this is refused at load, not sampled.
 *   3. The data files sit outside every mutation boundary: L3 may patch only
 *      the files it lists by name (code-genome.ts `allowlistPaths`), and
 *      `field-data/` is not among them. `dataHash` goes into the manifest, so a
 *      changed blocklist or extract is a different campaign.
 *   4. `partitionsApprovedBy` is the owner's sign-off on the family split
 *      (spec Q4 / OD7). The split here is the agent's draft until he signs;
 *      it is hashed, so signing it makes a new manifest.
 *
 * Licence (spec Q16, read 5 Oct 2026): O*NET 31.0 is CC BY 4.0; the
 * attribution and modification notice live in `field-data/field-plan.json` and
 * must travel with any report that quotes a task statement.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Partition } from "../infra/campaign.ts";
import { sha256Canonical } from "../infra/hash-chain.ts";
import { PARTITIONS } from "./task-family.ts";

export const DATA_DIR = join(import.meta.dir, "field-data");

export interface FieldPlan {
  schemaVersion: 1;
  source: string;
  attribution: string;
  /** SOC major group code ("43") -> name. */
  familyNames: Record<string, string>;
  partitions: Record<Partition, string[]>;
  partitionsApprovedBy: { by: string; date: string } | null;
  blocklist: { version: string; families: string[]; occupations: { code: string; title: string }[]; terms: string[] };
}

/** One sampleable task statement. */
export interface FieldTask {
  /** SOC major group, the first two digits of the code. */
  family: string;
  code: string;
  title: string;
  taskId: string;
  task: string;
}

export interface FieldData {
  plan: FieldPlan;
  /** Allowed tasks per family, after the blocklist. */
  byFamily: ReadonlyMap<string, readonly FieldTask[]>;
  blocked: number;
  /** sha256 of the extract text and the plan. Goes into the manifest. */
  dataHash: string;
}

/** Reasons the plan is unusable; empty means valid. */
export function validatePlan(plan: FieldPlan): string[] {
  const out: string[] = [];
  const blockedFamilies = new Set(plan.blocklist.families);
  const placed = new Map<string, Partition>();
  for (const part of PARTITIONS) {
    for (const f of plan.partitions[part] ?? []) {
      if (!(f in plan.familyNames)) out.push(`partition ${part} names unknown family "${f}"`);
      if (blockedFamilies.has(f)) out.push(`family "${f}" is blocked but sits in ${part}`);
      const first = placed.get(f);
      if (first) out.push(`family "${f}" is in both ${first} and ${part}`);
      else placed.set(f, part);
    }
  }
  for (const f of Object.keys(plan.familyNames)) {
    if (!blockedFamilies.has(f) && !placed.has(f)) out.push(`family "${f}" is in no partition and not blocked`);
  }
  if ((plan.partitions.development ?? []).length === 0) out.push("development has no families");
  if (!plan.attribution.includes("CC BY 4.0")) out.push("the O*NET attribution is missing");
  for (const t of plan.blocklist.terms) {
    try {
      new RegExp(t, "i");
    } catch {
      out.push(`blocklist term is not a valid pattern: ${t}`);
    }
  }
  return out;
}

/** Parse the extract and apply the blocklist. Throws on an invalid plan, so
 *  a broken split or blocklist can never be sampled from. */
export function loadFieldData(extractTsv: string, plan: FieldPlan): FieldData {
  const problems = validatePlan(plan);
  if (problems.length) throw new Error(`field plan refused: ${problems.join("; ")}`);
  const bl = plan.blocklist;
  const blockedFamilies = new Set(bl.families);
  const blockedCodes = new Set(bl.occupations.map((o) => o.code));
  const term = new RegExp(bl.terms.join("|"), "i");

  const byFamily = new Map<string, FieldTask[]>();
  let blocked = 0;
  const rows = extractTsv.split("\n").slice(1);
  for (const row of rows) {
    if (!row) continue;
    const [code, title, taskId, task] = row.split("\t");
    if (!code || !title || !taskId || !task) throw new Error(`extract row is malformed: ${row.slice(0, 80)}`);
    const family = code.slice(0, 2);
    if (blockedFamilies.has(family) || blockedCodes.has(code) || term.test(task) || term.test(title)) {
      blocked++;
      continue;
    }
    const list = byFamily.get(family) ?? [];
    list.push({ family, code, title, taskId, task });
    byFamily.set(family, list);
  }
  return { plan, byFamily, blocked, dataHash: sha256Canonical({ extract: extractTsv, plan }) };
}

/** The checked-in data files. */
export function loadDefaultFieldData(dir = DATA_DIR): FieldData {
  const tsv = readFileSync(join(dir, "onet-31.0-tasks.tsv"), "utf8").replace(/\r\n/g, "\n");
  const plan = JSON.parse(readFileSync(join(dir, "field-plan.json"), "utf8")) as FieldPlan;
  return loadFieldData(tsv, plan);
}

/**
 * Draw one task from `partition`. A family's weight is 1 / (1 + times it has
 * been covered), so an empty family is the most likely draw and a covered
 * one never drops to zero. Within the family, every task is equally likely.
 */
export function sampleField(
  data: FieldData,
  partition: Partition,
  coverage: Readonly<Record<string, number>>,
  rng: () => number,
): FieldTask {
  const families = data.plan.partitions[partition].filter((f) => (data.byFamily.get(f)?.length ?? 0) > 0);
  if (families.length === 0) throw new Error(`partition ${partition} has no family with an allowed task`);
  const weights = families.map((f) => 1 / (1 + Math.max(0, coverage[f] ?? 0)));
  let r = rng() * weights.reduce((s, w) => s + w, 0);
  let family = families[families.length - 1]!;
  for (let i = 0; i < families.length; i++) {
    r -= weights[i]!;
    if (r < 0) {
      family = families[i]!;
      break;
    }
  }
  const tasks = data.byFamily.get(family)!;
  return tasks[Math.floor(rng() * tasks.length)]!;
}
