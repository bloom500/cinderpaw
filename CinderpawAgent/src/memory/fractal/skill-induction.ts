/**
 * skill-induction.ts — Turn a fully-verified DSL program into a reusable
 * tool and persist it in the RAPTOR memory tree's skill layer.
 *
 * This is the last stage of the ARC harness loop (perception → world-model
 * → MCTS+verifier → SKILL INDUCTION): only code that compiles cleanly is
 * accepted — the verifier guarantees task correctness upstream, this module
 * guarantees runnability downstream.
 *
 * Storage: append-only JSONL under ~/.cinderpaw/agent/raptor-skills.jsonl
 * (same convention as fractal-leaves.jsonl). The sink is injectable for
 * tests and alternative stores. Identical (code, description) pairs are
 * deduplicated by content hash, never written twice.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { compileProgram } from "../../core/mcts-verifier.ts";

export interface ReusableSkill {
  /** Content-hash id: `skill-<fnv1a32(code::description)>`. */
  id: string;
  /** Slugified task description, usable as a tool name. */
  name: string;
  programCode: string;
  description: string;
  inducedAt: string;
  source: "mcts-verifier";
  verificationStatus: "fully-verified";
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

/** Default persistence location (matches the fractal-leaves convention). */
export function defaultSinkPath(): string {
  return path.join(os.homedir(), ".cinderpaw", "agent", "raptor-skills.jsonl");
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
  sink?: SkillSink;
  now?: Date;
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
  options: InduceSkillOptions = {},
): Promise<{ skill: ReusableSkill; savedTo: string; duplicated: boolean }> {
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
    verificationStatus: "fully-verified",
  };

  const sink = options.sink ?? new JsonlSkillSink(defaultSinkPath());
  const duplicated = (await sink.has?.(id)) ?? false;
  if (!duplicated) {
    await sink.append(skill);
  }
  return { skill, savedTo: sink.describe?.() ?? "<custom-sink>", duplicated };
}
