/**
 * S1.11 of the AgentLoop evolution spec (2026-10-04, §4.3, §7, §26 H23):
 * the verifier ladder above V1.
 *
 *   V2  grounded facts: the work must contain facts that exist only in the
 *       planted inputs and must not contain the planted distractors. Built
 *       as an ordinary composite check, so the evaluator (S1.2) runs it in
 *       a cell like any other.
 *   V3  judge panel: two or more models from different providers score the
 *       work against ONE fixed generic rubric. Advisory only.
 *   V4  human sample: 20 items per campaign, drawn after the runs, blind to
 *       the agent that produced them.
 *
 * RESEARCH ONLY (spec §4.7).
 *
 * Rules this file holds:
 *   1. V3 never changes `passed`. Its disagreement with V1/V2 is recorded,
 *      nothing more ("LLM-as-a-Judge Is Not an Oracle").
 *   2. Only V1 and V2 promote. A field where only V3 works is explorable,
 *      never promotable.
 *   3. The rubric is fixed here and hashed, never generated per task
 *      (ImpossibleRubrics: generated rubrics are exploited more often).
 *   4. The V4 export carries no executor, arm or task id; the key that maps
 *      items back stays with the orchestrator.
 */

import { sha256Canonical } from "../infra/hash-chain.ts";
import { rngOf } from "../infra/fixtures.ts";
import type { Check, Verdict } from "./agent-evaluator.ts";
import { checkArgv } from "./feasibility.ts";

export type Rung = "V1" | "V2" | "V3";

/** Rule 2: what a field may be used for, from the rungs its tasks reach. */
export function fieldUse(rungs: readonly Rung[]): "promotable" | "explorable_not_promotable" {
  return rungs.includes("V1") || rungs.includes("V2") ? "promotable" : "explorable_not_promotable";
}

const CHECK_MS = 30_000;
const insideWorkspace = (p: string) => !!p && !p.startsWith("/") && !p.includes("\\") && !/^[a-zA-Z]:/.test(p) && !p.split("/").includes("..");

/** A Bun program: exit 0 when `path` in the workspace contains `text` (or
 *  lacks it, for a distractor). A missing file fails both ways. */
function containsProgram(path: string, text: string, want: boolean): string {
  return (
    `const t=require("node:fs").readFileSync(process.argv[1]+"/"+${JSON.stringify(path)},"utf8");` +
    `process.exit(t.includes(${JSON.stringify(text)})===${want}?0:1);`
  );
}

/**
 * V2: one sub-check per planted fact (must appear) and per distractor (must
 * not). Runs from /tmp with the program in the argv, like every check that
 * reads a workspace the executor wrote (S1.4 rule).
 */
export function groundedFacts(spec: { path: string; facts: readonly string[]; distractors: readonly string[] }): Check {
  if (!insideWorkspace(spec.path)) throw new Error(`V2: path "${spec.path}" is outside the workspace`);
  if (spec.facts.length === 0) throw new Error("V2 needs at least one planted fact");
  if ([...spec.facts, ...spec.distractors].some((x) => !x.trim())) throw new Error("V2: an empty fact or distractor matches everything");
  const leaf = (id: string, text: string, want: boolean) => ({
    id,
    check: { kind: "command" as const, argv: checkArgv(containsProgram(spec.path, text, want)), timeoutMs: CHECK_MS },
  });
  return {
    kind: "composite",
    checks: [
      ...spec.facts.map((f, i) => leaf(`fact:${i + 1}`, f, true)),
      ...spec.distractors.map((d, i) => leaf(`distractor:${i + 1}`, d, false)),
    ],
  };
}

/** Rule 3. Changing a word changes the hash, and so the manifest. */
export const GENERIC_RUBRIC =
  "Score how well the work product completes the instruction, from 0 (not done or wrong) to 1 (fully and correctly done). " +
  "Judge only what the instruction asks for. Confident tone, length, headings and claims of completion earn nothing by themselves. " +
  "Answer with one number between 0 and 1 and nothing else.";
export const RUBRIC_HASH = sha256Canonical(GENERIC_RUBRIC);

export interface Judge {
  id: string;
  provider: string;
  /** Returns a score in [0, 1] for the work against the rubric. */
  score(input: { rubric: string; instruction: string; work: string }): Promise<number>;
}

export interface LadderVerdict {
  verdict: Verdict;
  /** Who decided `passed`: a program (V1) or planted facts (V2). */
  rung: "V1" | "V2";
  /** Advisory only (rule 1). */
  v3?: { rubricHash: string; scores: { judge: string; score: number }[]; mean: number; disagrees: boolean };
}

/**
 * V3 on top of a V1/V2 verdict. The returned verdict is the same object, so
 * `passed` cannot move. `disagrees` is true when the panel calls the work
 * good (mean >= 0.5) and the verdict failed it, or the reverse.
 */
export async function withJudgePanel(
  graded: { verdict: Verdict; rung: "V1" | "V2" },
  judges: readonly Judge[],
  input: { instruction: string; work: string },
): Promise<LadderVerdict> {
  if (judges.length < 2) throw new Error("V3 needs at least two judges");
  if (new Set(judges.map((j) => j.provider)).size < judges.length) throw new Error("V3 judges must come from different providers");
  const scores: { judge: string; score: number }[] = [];
  for (const j of judges) {
    const s = await j.score({ rubric: GENERIC_RUBRIC, ...input });
    if (!Number.isFinite(s) || s < 0 || s > 1) throw new Error(`judge ${j.id} returned ${s}, not a score in [0, 1]`);
    scores.push({ judge: j.id, score: s });
  }
  const mean = scores.reduce((t, x) => t + x.score, 0) / scores.length;
  return { ...graded, v3: { rubricHash: RUBRIC_HASH, scores, mean, disagrees: mean >= 0.5 !== graded.verdict.passed } };
}

/** §7 / H23: V4 is 20 blind items per campaign, drawn after the runs. */
export const V4_ITEMS = 20;

export interface V4Source {
  verdict: Verdict;
  arm: string;
  language: string;
  instruction: string;
  work: string;
}

/** What the human sees: no executor, arm, task id or verdict. */
export interface V4Item {
  itemId: string;
  language: string;
  instruction: string;
  work: string;
}

/** Kept by the orchestrator; the reviewer never gets it. */
export interface V4KeyEntry {
  itemId: string;
  taskId: string;
  executorHash: string;
  arm: string;
  passed: boolean;
}

/** Draws `n` items without replacement, seeded, shuffled, ids opaque. */
export function v4Export(sources: readonly V4Source[], seed: number, n = V4_ITEMS): { items: V4Item[]; key: V4KeyEntry[] } {
  const rng = rngOf(seed);
  const pool = [...sources];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const drawn = pool.slice(0, n);
  const items: V4Item[] = [];
  const key: V4KeyEntry[] = [];
  for (const [i, s] of drawn.entries()) {
    const itemId = `item-${String(i + 1).padStart(2, "0")}`;
    items.push({ itemId, language: s.language, instruction: s.instruction, work: s.work });
    key.push({ itemId, taskId: s.verdict.taskId, executorHash: s.verdict.executorHash, arm: s.arm, passed: s.verdict.passed });
  }
  return { items, key };
}
