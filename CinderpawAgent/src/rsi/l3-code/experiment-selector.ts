/**
 * M0: the experiment selector — the first learner of the recursive-learning
 * spec (docs/superpowers/specs/2026-09-12-recursive-learning-design.md, §6,
 * milestone S3).
 *
 * Until now `proposeCodePatch` picked its target file with `rng()`. Nobody
 * chose the experiment, so nothing about the search could be learned: a file
 * that had been rejected ten times was as likely as one never opened, and the
 * proposer re-proposed the same rejected idea because it was never told.
 *
 * This is a deterministic hand-written policy over the ledger of past
 * attempts. It is deliberately dumb: the spec's H1 asks whether an EVOLVED
 * selector beats M0, and M0 has to be simple enough that beating it means
 * something. It is also denylisted from L3's own patch wall: a selector that
 * L3 can rewrite is the recursion hook (spec §7 H2), and that opens at S5,
 * not here.
 *
 * Every function here is pure or a thin file append; nothing touches the
 * evaluator, the budget or the ratchet.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../infra/instance-paths.ts";

/** One L3 round, as the ledger remembers it. */
export interface Attempt {
  /** rsi/-relative path, e.g. "l1-config/mutation.ts". */
  file: string;
  /** The proposer's one-line RATIONALE. */
  rationale: string;
  verdict: "accept" | "reject" | "halt";
  /** The contract's reason for the verdict. */
  reason: string;
  /** Epoch ms. */
  ts: number;
}

/** What the selector hands the proposer. */
export interface Experiment {
  target: string;
  /** Evidence for the prompt: what was already tried here and refused. */
  brief: string;
}

/** Consecutive rejects/halts that take a file out of the pool until an
 *  accept lands on it. Three, not one: a single rejection is usually the
 *  proposal, not the file. */
export const MAX_STRIKES = 3;

/** Where the ledger lives. Beside the journal, not in it: journal rows are
 *  hash-chained evidence for L6, and this is search bookkeeping. */
export function defaultAttemptLedgerPath(): string {
  return join(paths().root, "code-attempts.jsonl");
}

/** Read every well-formed line. A missing file is an empty history, and a
 *  torn last line (a crash mid-append) drops that line only. */
export function readAttempts(path: string): Attempt[] {
  if (!existsSync(path)) return [];
  const out: Attempt[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const a = JSON.parse(line) as Attempt;
      if (typeof a.file === "string" && typeof a.verdict === "string") out.push(a);
    } catch {
      // torn line: skipped on purpose
    }
  }
  return out;
}

export function appendAttempt(path: string, attempt: Attempt): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(attempt) + "\n");
}

/** Strikes = rejects/halts since the last accept on that file. */
function strikesOf(history: Attempt[]): number {
  let n = 0;
  for (const a of [...history].sort((x, y) => y.ts - x.ts)) {
    if (a.verdict === "accept") break;
    n++;
  }
  return n;
}

/**
 * The policy. In order:
 *   1. files struck out (MAX_STRIKES in a row) are not offered;
 *   2. a file never tried beats every file that was;
 *   3. among the tried, the least recently tried goes first;
 *   4. ties fall to `rng`, so two fresh files are not always taken in
 *      directory order.
 * Returns null when nothing is left to try.
 */
export function selectExperiment(
  files: string[],
  attempts: Attempt[],
  rng: () => number = Math.random,
): Experiment | null {
  const byFile = new Map<string, Attempt[]>();
  for (const a of attempts) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a]);

  const pool = files.filter((f) => strikesOf(byFile.get(f) ?? []) < MAX_STRIKES);
  if (pool.length === 0) return null;

  const lastTried = (f: string) => Math.max(0, ...(byFile.get(f) ?? []).map((a) => a.ts));
  const best = Math.min(...pool.map(lastTried));
  const candidates = pool.filter((f) => lastTried(f) === best);
  const target = candidates[Math.floor(rng() * candidates.length)]!;

  const refused = (byFile.get(target) ?? [])
    .filter((a) => a.verdict !== "accept")
    .sort((x, y) => y.ts - x.ts)
    .map((a) => `- "${a.rationale}" (${a.verdict}: ${a.reason})`);
  const brief =
    refused.length === 0
      ? "No previous attempt on this file."
      : `Already proposed on this file and refused, newest first. Do not repeat these:\n${refused.join("\n")}`;
  return { target, brief };
}
