/**
 * Faza 2 Slice 1 — CodeGenome on-disk envelope (disk layer).
 *
 * Mirrors the discipline of `population-snapshot.ts`: a versioned envelope
 * (`{ version, genome }`) so an incompatible upgrade degrades cleanly. Reads
 * return `null` on missing/corrupt/version-mismatched input rather than
 * throwing — a bad genome must never abort the engine.
 *
 * Write returns the JSON string. The envelope is plain ASCII and contains
 * the FULL CodeGenome (patch text + provenance); an audit can reconstruct
 * exactly what was proposed.
 */

import type { CodeGenome } from "./code-genome.ts";

const GENOME_VERSION = 1;

interface Envelope {
  version: number;
  genome: CodeGenome;
}

/** Serialize a CodeGenome to the versioned envelope string. */
export function serializeCodeGenome(g: CodeGenome): string {
  const env: Envelope = { version: GENOME_VERSION, genome: g };
  return JSON.stringify(env);
}

/** Read a CodeGenome from an envelope string. Returns null on any failure:
 *  bad JSON, wrong version, missing fields, wrong field types. Never throws. */
export function deserializeCodeGenome(s: string): CodeGenome | null {
  if (typeof s !== "string" || s === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return null;
  }
  if (!isEnvelope(parsed)) return null;
  return parsed.genome;
}

function isEnvelope(v: unknown): v is Envelope {
  if (!v || typeof v !== "object") return false;
  const env = v as { version?: unknown; genome?: unknown };
  if (env.version !== GENOME_VERSION) return false;
  return isCodeGenome(env.genome);
}

function isCodeGenome(v: unknown): v is CodeGenome {
  if (!v || typeof v !== "object") return false;
  const g = v as Partial<CodeGenome> & { proposal?: unknown };
  if (typeof g.patch !== "string") return false;
  if (!Array.isArray(g.affectedFiles)) return false;
  if (!g.affectedFiles.every((p) => typeof p === "string")) return false;
  if (typeof g.baseCommit !== "string") return false;
  if (!g.proposal || typeof g.proposal !== "object") return false;
  const p = g.proposal as CodeGenome["proposal"];
  return (
    typeof p.rationale === "string" &&
    typeof p.riskAssessment === "string" &&
    typeof p.testPlan === "string"
  );
}