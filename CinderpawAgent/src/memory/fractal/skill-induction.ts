/**
 * skill-induction.ts — Turn a fully-verified DSL program into a reusable
 * tool and persist it in the RAPTOR memory tree's skill layer.
 *
 * This is the last stage of the ARC harness loop (perception → world-model
 * → MCTS+verifier → SKILL INDUCTION): only code that compiles cleanly is
 * accepted — the verifier guarantees task correctness upstream, this module
 * guarantees runnability downstream.
 *
 * Storage: append-only JSONL under
 * <feralHome()>/agent/runs/<runId>/raptor-skills.jsonl. The sink is
 * injectable for tests and alternative stores. Identical (code,
 * description) pairs are deduplicated by content hash, never written twice.
 *
 * ISOLATION CONTRACT (INV-F). `runId` is REQUIRED and there is no unscoped
 * default. A skill induced while solving task N must not be silently
 * present while solving task N+1 - that is benchmark contamination, and it
 * is invisible after the fact: a scorecard cannot tell you which episodes
 * were tainted. Scoping by run makes carry-over a deliberate act (copy the
 * file, or point two runs at one sink on purpose) instead of the default.
 *
 * Interactive, non-benchmark use is not special-cased: it passes a stable
 * runId such as "interactive" and gets accumulation. The scope is then
 * visible in the path on disk, which is the point - you can see what a
 * given run was allowed to remember by looking at where it wrote.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { compileProgram } from "../../core/mcts-verifier.ts";
import { assertValidRunId } from "../../core/run-id.ts";
import { feralHome } from "../../config.ts";

// Re-exported: this module was the original home of the check, and
// callers/tests import it from here.
export { assertValidRunId };

export interface ReusableSkill {
  /** Content-hash id: `skill-<fnv1a32(code::description)>`. */
  id: string;
  /** Slugified task description, usable as a tool name. */
  name: string;
  programCode: string;
  description: string;
  inducedAt: string;
  source: "mcts-verifier";
  /**
   * What the evidence ACTUALLY supports, never a constant.
   *
   * - `held-out-verified` — reproduced pairs the search never saw.
   * - `train-only` — fits the examples it was fitted to. That is the
   *   definition of the claim being circular, so it is named as such
   *   rather than dressed up as verification.
   */
  verificationStatus: "held-out-verified" | "train-only";
  /** The counts behind the status, so a reader can audit the claim. */
  evidence: { trainPairs: number; heldOutPairs: number };
  /** The run that induced it. Provenance travels with the record, so a
   *  merged file still says which episode each skill came from. */
  runId: string;
}

/**
 * Evidence the caller must hand over. Mirrors what `runMCTSVerification`
 * returns: search-set size, held-out size, and whether the held-out set
 * passed. There is no default — a caller that has not measured
 * generalization has to say so in the record.
 */
export interface SkillEvidence {
  trainPairs: number;
  heldOutPairs: number;
  heldOutPassed: boolean;
}

/** Persistence seam — implement to store skills somewhere else. */
export interface SkillSink {
  append(skill: ReusableSkill): Promise<void>;
  has?(id: string): Promise<boolean>;
  describe?(): string;
}

/** Append-only JSONL sink at the given path. */
export class JsonlSkillSink implements SkillSink {
  constructor(readonly filePath: string) {}

  async has(id: string): Promise<boolean> {
    if (!fs.existsSync(this.filePath)) return false;
    const text = await fsp.readFile(this.filePath, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        if ((JSON.parse(line) as ReusableSkill).id === id) return true;
      } catch {
        // A torn/corrupt line must not crash induction; skip it.
        continue;
      }
    }
    return false;
  }

  async append(skill: ReusableSkill): Promise<void> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    await fsp.appendFile(this.filePath, `${JSON.stringify(skill)}\n`, "utf8");
  }

  describe(): string {
    return this.filePath;
  }
}

/**
 * Per-run persistence location (fractal-leaves convention, run-scoped).
 *
 * Derived from `feralHome()`, not from `homedir()` directly. Reading the home
 * dir here meant an isolated profile (CINDERPAW_HOME) still wrote its induced
 * skills into the real profile's directory — the one place in the sidecar
 * where agent state escaped its own home, and the one kind of state whose
 * whole purpose is to not leak between runs.
 */
export function defaultSinkPath(runId: string): string {
  assertValidRunId(runId);
  return path.join(feralHome(), "agent", "runs", runId, "raptor-skills.jsonl");
}

function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function slugify(description: string): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug === "" ? "skill" : slug;
}

export interface InduceSkillOptions {
  /** REQUIRED. The episode/run this skill belongs to. See ISOLATION CONTRACT. */
  runId: string;
  /** REQUIRED. See SkillEvidence — the claim must carry its proof. */
  evidence: SkillEvidence;
  sink?: SkillSink;
  now?: Date;
}

/**
 * Refuse evidence that cannot support any claim.
 *
 * The load-bearing rule is the last one: a program that was measured
 * against held-out data and FAILED must never be persisted. Writing it
 * anyway is how a wrong rule becomes a reusable tool, and how the memory
 * tree starts teaching the agent something false with a "verified" label
 * on it. Failing generalization is a result; it is not a skill.
 */
export function assertUsableEvidence(evidence: unknown): asserts evidence is SkillEvidence {
  const e = evidence as SkillEvidence | undefined;
  if (!e || typeof e !== "object") {
    throw new Error(
      "induceReusableSkill: evidence is required — { trainPairs, heldOutPairs, heldOutPassed }",
    );
  }
  for (const key of ["trainPairs", "heldOutPairs"] as const) {
    const v = e[key];
    if (!Number.isInteger(v) || (v as number) < 0) {
      throw new Error(
        `induceReusableSkill: evidence.${key} must be a non-negative integer, got ${String(v)}`,
      );
    }
  }
  if (e.trainPairs < 1) {
    throw new Error(
      "induceReusableSkill: evidence.trainPairs must be ≥ 1 — a skill verified against nothing is not verified",
    );
  }
  if (typeof e.heldOutPassed !== "boolean") {
    throw new Error(
      `induceReusableSkill: evidence.heldOutPassed must be a boolean, got ${String(e.heldOutPassed)}`,
    );
  }
  if (e.heldOutPairs > 0 && !e.heldOutPassed) {
    throw new Error(
      "induceReusableSkill: refusing to induce a skill that FAILED held-out verification — " +
        "a program that does not generalize is a result to log, never a tool to reuse",
    );
  }
}

/**
 * Convert verified program code into a persisted reusable skill.
 *
 * Loud failure modes: empty inputs, or code that does not compile against
 * the DSL scope — an unverifiable tool never reaches the memory tree.
 * Duplicate induction of identical content returns the existing identity
 * with `duplicated: true` without writing again.
 */
export async function induceReusableSkill(
  verifiedProgramCode: string,
  taskDescription: string,
  options: InduceSkillOptions,
): Promise<{ skill: ReusableSkill; savedTo: string; duplicated: boolean }> {
  // Checked FIRST: an unscoped induction must fail before it can write
  // anywhere, not after the compile check has already spent work.
  assertValidRunId(options?.runId);
  assertUsableEvidence(options?.evidence);
  if (typeof verifiedProgramCode !== "string" || verifiedProgramCode.trim() === "") {
    throw new Error("induceReusableSkill: verifiedProgramCode must be a non-empty string");
  }
  if (typeof taskDescription !== "string" || taskDescription.trim() === "") {
    throw new Error("induceReusableSkill: taskDescription must be a non-empty string");
  }
  try {
    compileProgram(verifiedProgramCode);
  } catch (e) {
    throw new Error(
      `induceReusableSkill: refusing to induce a non-runnable skill — ${(e as Error).message}`,
    );
  }

  const id = `skill-${fnv1a32(`${verifiedProgramCode}::${taskDescription}`)}`;
  const skill: ReusableSkill = {
    id,
    name: slugify(taskDescription),
    programCode: verifiedProgramCode,
    description: taskDescription,
    inducedAt: (options.now ?? new Date()).toISOString(),
    source: "mcts-verifier",
    verificationStatus:
      options.evidence.heldOutPairs > 0 ? "held-out-verified" : "train-only",
    evidence: {
      trainPairs: options.evidence.trainPairs,
      heldOutPairs: options.evidence.heldOutPairs,
    },
    runId: options.runId,
  };

  const sink = options.sink ?? new JsonlSkillSink(defaultSinkPath(options.runId));
  const duplicated = (await sink.has?.(id)) ?? false;
  if (!duplicated) {
    await sink.append(skill);
  }
  return { skill, savedTo: sink.describe?.() ?? "<custom-sink>", duplicated };
}
