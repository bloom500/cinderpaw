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
 * Metacognition (13 Sep): every attempt now carries what the proposer
 * PREDICTED about itself before running (chance of acceptance, effect, cost,
 * the failure it expects, the information it lacks) and what was OBSERVED
 * after. `self-model.ts` turns that ledger into a model of the agent's own
 * competence, and the policy below spends experiments where that model is
 * least sure and the expected gain is largest, instead of round-robin. The
 * predictions are the agent's; the verdicts are the contract's. It never
 * grades itself.
 *
 * Every function here is pure or a thin file append; nothing touches the
 * evaluator, the budget or the ratchet.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "../infra/instance-paths.ts";
import { buildSelfModel, experimentValue } from "./self-model.ts";

/** Why the proposer thinks an attempt would fail, if it fails. A fixed
 *  vocabulary on purpose: a free-text reason cannot be counted, and counting
 *  is how a pattern of error becomes a fact about the agent. */
export const FAILURE_CLASSES = [
  /** The idea is wrong for this file. */
  "wrong_proposal",
  /** The file is the wrong place to look. */
  "wrong_file",
  /** The evaluator does not measure what the change improves. */
  "unmeasured",
  /** Something the proposer needed to know and did not. */
  "missing_info",
  /** The change needs a tool the agent does not have (competence plan §2.4;
   *  recorded as the input signal for the skill library, §3.1). */
  "need_tool",
  /** The change needs a method the agent has not got: it would have to
   *  experiment first (input to §3.2). */
  "need_method",
  /** The change is real but costs more than the round is allowed to spend.
   *  Treated like `missing`: a question to the user, not a round. */
  "over_mandate",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** What the proposer said about itself BEFORE the contract ran. */
export interface Prediction {
  /** Chance the contract accepts, in [0, 1]. */
  pAccept: number;
  /** Expected score gain if accepted, in score points (0 = none). */
  expectedEffect: number;
  /** Expected tokens for the round. */
  expectedCost: number;
  /** The failure it expects if it fails; null = "I expect to pass". */
  failureClass: FailureClass | null;
  /** Information it says it lacks; null = none. A non-null value is a
   *  question for the user and the round does not run. */
  missing: string | null;
}

/** What the contract actually did. Written by the runner, never the model. */
export interface Observation {
  accepted: boolean;
  /** Score delta when accepted; null when there was no score. */
  effect: number | null;
  /** Tokens actually spent. */
  cost: number;
  /** The runner's classification of the failure, when it can tell. */
  failureClass: FailureClass | null;
}

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
  /** Absent on rows written before 13 Sep 2026. */
  predicted?: Prediction;
  observed?: Observation;
  /** What the world looked like before the intervention: the commit the
   *  patch applied on, and the hash of the file as the proposer read it.
   *  Together with `file` this is the reproduction. Absent on old rows. */
  initialState?: { baseCommit: string; fileHash: string };
  /** Which learner produced this round: the selector policy and the exact
   *  prompt. A receipt is only comparable to another under the same method. */
  methodVersion?: { selector: string; promptHash: string };
  /** The candidate this receipt is about, so a later event on the same
   *  candidate (the user rejecting it, the apply failing) can find it. */
  genomeId?: string;
  /** Receipts this one shows to be no longer valid (`receiptId`). The
   *  invalidated rows stay in history and out of the self-model: "X was
   *  believed until R showed otherwise" (competence plan §2.5). */
  invalidates?: string[];
}

/** A receipt's identity: file and time. Deterministic, so rows written
 *  before ids existed have one too. */
export function receiptId(a: Pick<Attempt, "file" | "ts">): string {
  return `${a.file}@${a.ts}`;
}

/**
 * The receipts the loop should still believe: everything not invalidated
 * by a later one. The invalidated rows are not deleted, they are handed
 * back separately so the brief can say what was believed and what ended it.
 */
export function effectiveAttempts(attempts: Attempt[]): {
  live: Attempt[];
  invalidated: Map<string, Attempt>;
} {
  const invalidated = new Map<string, Attempt>();
  for (const a of attempts) for (const id of a.invalidates ?? []) invalidated.set(id, a);
  return { live: attempts.filter((a) => !invalidated.has(receiptId(a))), invalidated };
}

/** What the selector hands the proposer. */
export interface Experiment {
  target: string;
  /** Evidence for the prompt: what was already tried here and refused. */
  brief: string;
}

/** The selection policy's version, written on every receipt as
 *  `methodVersion.selector`. Bump BY HAND when `selectExperiment` or
 *  `self-model.ts` changes what gets picked: two receipts with different
 *  selector versions were produced by different learners, and the campaign
 *  runner (S1) compares learners, not rounds. History: m0.1 = round-robin
 *  with strikes (13 Sep); m0.2 = uncertainty x gain from the self-model. */
export const SELECTOR_VERSION = "m0.2";

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

/** Marks the receipt JSON inside an FMS episode line. */
export const RECEIPT_TAG = "[rsi-receipt]";

/**
 * The receipt as one FMS episode: a human line first, so the dream cycle
 * and recall read it like any other experience, then the machine-readable
 * receipt on its own line. One row, both readers. This is how BRSI writes
 * into FMS (competence plan §2.2).
 */
export function receiptLine(a: Attempt): string {
  const human = `[rsi-l3] ${a.verdict} on ${a.file}: "${a.rationale}" (${a.reason})`;
  return `${human}\n${RECEIPT_TAG} ${JSON.stringify(a)}`;
}

/**
 * The receipts back out of FMS episodes. This is how BRSI READS FMS: M0 is
 * handed these, not the jsonl, so a ledger file that was deleted or never
 * synced does not make the loop forget what it tried. Lines without the tag
 * (rows from before receipts existed) are skipped; a torn JSON tail is
 * skipped too, never thrown.
 */
export function attemptsFromEpisodes(events: readonly { content: string }[]): Attempt[] {
  const out: Attempt[] = [];
  for (const ev of events) {
    const i = ev.content.indexOf(RECEIPT_TAG);
    if (i < 0) continue;
    try {
      const a = JSON.parse(ev.content.slice(i + RECEIPT_TAG.length).trim()) as Attempt;
      if (typeof a.file === "string" && typeof a.verdict === "string") out.push(a);
    } catch {
      // torn tail: skipped on purpose
    }
  }
  return out;
}

/** Union of two receipt sources, one row per (file, ts). FMS and the jsonl
 *  hold the same rounds; whichever survived a crash or a wipe wins. */
export function mergeAttempts(...sources: Attempt[][]): Attempt[] {
  const seen = new Map<string, Attempt>();
  for (const src of sources) for (const a of src) seen.set(`${a.file}@${a.ts}`, a);
  return [...seen.values()].sort((x, y) => x.ts - y.ts);
}

function groupByFile(attempts: Attempt[]): Map<string, Attempt[]> {
  const byFile = new Map<string, Attempt[]>();
  for (const a of attempts) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a]);
  return byFile;
}

/** The files still worth offering: everything not struck out. Exported so
 *  the round can ask "is there anything left to learn here" before it pays
 *  for a proposal. */
export function poolOf(files: string[], attempts: Attempt[]): string[] {
  const byFile = groupByFile(attempts);
  return files.filter((f) => strikesOf(byFile.get(f) ?? []) < MAX_STRIKES);
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
 *   2. among the rest, the file where the self-model is least sure and the
 *      expected gain is largest goes first (`experimentValue`);
 *   3. equal value: fewer rounds first (a file never tried is still the
 *      first thing to learn about), then the least recently tried;
 *   4. ties fall to `rng`, so two fresh files are not always taken in
 *      directory order.
 * Returns null when nothing is left to try.
 */
export function selectExperiment(
  files: string[],
  attempts: Attempt[],
  rng: () => number = Math.random,
): Experiment | null {
  const { live, invalidated } = effectiveAttempts(attempts);
  const byFile = groupByFile(live);
  const pool = poolOf(files, live);
  if (pool.length === 0) return null;

  const model = buildSelfModel(live);
  const value = (f: string) => experimentValue(model, f);
  const rounds = (f: string) => (byFile.get(f) ?? []).length;
  const lastTried = (f: string) => Math.max(0, ...(byFile.get(f) ?? []).map((a) => a.ts));
  let candidates = pool;
  for (const [key, pick] of [
    [value, Math.max],
    [rounds, Math.min],
    [lastTried, Math.min],
  ] as const) {
    const best = pick(...candidates.map(key));
    candidates = candidates.filter((f) => key(f) === best);
  }
  const target = candidates[Math.floor(rng() * candidates.length)]!;

  // What was believed and then overturned on this file, so the proposer
  // does not re-propose an idea that passed the contract and failed the
  // person or the apply.
  const overturned = attempts
    .filter((a) => a.file === target && invalidated.has(receiptId(a)))
    .sort((x, y) => y.ts - x.ts)
    .map((a) => {
      const by = invalidated.get(receiptId(a))!;
      return `- "${a.rationale}" was accepted, then overturned (${by.reason})`;
    });
  const refused = (byFile.get(target) ?? [])
    .filter((a) => a.verdict !== "accept")
    .sort((x, y) => y.ts - x.ts)
    // A row with no observation is a claim: the contract's verdict is there,
    // but nothing recorded what was measured (rows from before receipts, or a
    // round whose observation write was lost). The proposer is told so.
    .map(
      (a) =>
        `- "${a.rationale}" (${a.verdict}: ${a.reason})` +
        (a.observed ? "" : " [claimed, not verified]"),
    );
  const lines = [...overturned, ...refused];
  const brief =
    lines.length === 0
      ? "No previous attempt on this file."
      : `Already proposed on this file and refused, newest first. Do not repeat these:\n${lines.join("\n")}`;
  return { target, brief };
}
