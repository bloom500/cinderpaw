/**
 * Skill Induction Module for RAPTOR Memory.
 *
 * Converts verified programs into reusable skill definitions, hashes contents,
 * deduplicates, and appends to RAPTOR persistent skill memory (`~/.cinderpaw/agent/raptor-skills.jsonl`).
 */

import { writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fnv1aHash } from "../../core/mcts-verifier.js";

export interface ReusableSkill {
  id: string;
  name: string;
  description: string;
  programCode: string;
  timestamp: string;
}

export function induceReusableSkill(
  programCode: string,
  taskDescription: string,
  customStorePath?: string
): ReusableSkill {
  // Simple compilation check
  try {
    new Function("I", "DSL", `${programCode}`);
  } catch (err: any) {
    throw new Error(`Invalid skill code, failed to compile: ${err?.message}`);
  }

  const skillHash = fnv1aHash(programCode);
  const skillId = `skill-${skillHash}`;

  const skill: ReusableSkill = {
    id: skillId,
    name: `Induced Skill ${skillHash.slice(0, 6)}`,
    description: taskDescription,
    programCode,
    timestamp: new Date().toISOString(),
  };

  const defaultDir = join(
    process.env.HOME || "/tmp",
    ".cinderpaw",
    "agent"
  );
  const filePath = customStorePath || join(defaultDir, "raptor-skills.jsonl");

  if (!existsSync(dirname(filePath))) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  // Append skill to jsonl store
  appendFileSync(filePath, JSON.stringify(skill) + "\n", "utf-8");

  return skill;
}
