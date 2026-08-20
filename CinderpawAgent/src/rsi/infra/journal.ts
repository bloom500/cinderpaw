/**
 * Evolution Journal — the structured per-cycle log of what the RSI engine
 * observed, hypothesised, tried, observed again, and decided.
 *
 * Why this exists separate from `dream-telemetry.ts`:
 *   - `dream-telemetry.ts` writes one flat row per DREAM EPISODE
 *     (10 fields: startedAt / endedAt / trigger / iterations / tokens / …).
 *   - This module writes one row per DREAM CYCLE — the unit of evolution
 *     per BRSI §2.8 / §2.9. A cycle is the seven-stage orchestration
 *     (Wake → Observe → Dream → Mutate → Evaluate → Remember) and the
 *     row carries what was observed, hypothesised, experimented, the
 *     result, and the decision.
 *
 * The two logs are complementary, not redundant: telemetry answers
 * "how long did the dream run"; the journal answers "what did we learn".
 * Layer 5 (meta-evolution) reads the journal to learn from history.
 *
 * Discipline: best-effort JSONL append, mirrors `dream-telemetry.ts:7-13`
 * rationale — losing one journal row is much cheaper than letting a
 * transient FS hiccup abort a dream cycle. All errors swallowed silently.
 *
 * Schema is the per-cycle shape from `docs/brsi-spec.md` §2.9:
 *   observed / hypothesized / experimented / result / decided /
 *   budget_remaining.
 *
 * Hash chain (L5 G-INV-4, closes the old TODO(hash-chain, v2)): every
 * appended row carries `prevHash`/`hash` per the audit-log discipline —
 * sha256(prevHash || 0x02 || canonical(row)), genesis "GENESIS" (see
 * `hash-chain.ts`). The chain is per-day-file: each file starts from
 * GENESIS; cross-file chaining is v2. `verifyJournal(path)` walks a file
 * and reports the first bad row. Back-compat: pre-L5 rows without `hash`
 * verify as legacy and are accepted until the first chained row appears
 * in a file; after that, unchained rows fail.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chainHash, GENESIS } from "./hash-chain.ts";
import { paths } from "./instance-paths.ts";

/** The six components of the BRSI fitness vector (BRSI §2.2).
 *  All components are in [0, 1] — "higher better" vs "lower better" is
 *  implicit in the field name (latency / cost / hallucination are
 *  "lower better"; the rest are "higher better"). The aggregate is
 *  computed elsewhere; this shape carries the per-component values so
 *  the engine can switch from weighted-sum to Pareto selection later
 *  without re-running history. */
export interface FitnessVector {
  /** Higher better. */
  accuracy: number;
  /** Lower better. Normalised latency component. */
  latency: number;
  /** Lower better. Normalised cost component. */
  cost: number;
  /** Higher better. Tool-call success rate. */
  toolSuccess: number;
  /** Lower better. Hallucination rate (0 = never, 1 = always). */
  hallucination: number;
  /** Higher better. Personal signal — acceptance / completion / reuse. */
  userSatisfaction: number;
}

/** Which BRSI layer produced the candidate being journaled (BRSI §5).
 *  The journal is per-Layer-aware so a meta-evolution reader can
 *  filter "what did Layer 3 learn?" without grep. */
export type ExperimentLayer = "L0" | "L1" | "L2" | "L3" | "L4" | "L5";

/** The seven dream-cycle stages (BRSI §2.8). */
export type DreamStage =
  | "wake"
  | "observe"
  | "dream"
  | "mutate"
  | "evaluate"
  | "remember";

/** The terminal decision of a cycle (BRSI §2.9).
 *  - `accept`: candidate promoted (ratcheted). `reason` is the human-readable why.
 *  - `reject`: candidate evaluated but not promoted. `nextStep` is the
 *     follow-up plan (re-run with more samples, lower mutation rate, etc.).
 *  - `halt`:  cycle aborted before reaching a decision. `stage` says
 *     where in the pipeline it stopped; `reason` is the precondition
 *     that failed (e.g., "confidence below gate", "Tier 0 regression"). */
export type JournalDecision =
  | { action: "accept"; reason: string }
  | { action: "reject"; reason: string; nextStep: string }
  | { action: "halt"; reason: string; stage: DreamStage };

/** Remaining budget at cycle end (BRSI §2.5). */
export interface BudgetRemaining {
  wallClockMin: number;
  tokens: number;
  cpuPct: number;
  ramMb: number;
  diskMb: number;
}

/** One row in the journal. Written by the Remember stage of a dream cycle. */
export interface JournalEntry {
  /** Stable id for the cycle (e.g., "c-2026-07-14-001"). */
  cycleId: string;
  /** Wall-clock timestamp (ms since epoch). */
  timestamp: number;
  /** How long the cycle ran. */
  durationMin: number;
  /** Free-text observations from the Observe stage. */
  observed: string[];
  /** Hypotheses formed during the Dream stage. */
  hypothesized: string[];
  /** What was applied in the Mutate stage. Null for cycles with no
   *  candidate (e.g., cycles that halted at the Observe stage). */
  experimented: {
    candidateId: string;
    change: string;
    layer: ExperimentLayer;
  } | null;
  /** Result of the Evaluate stage. Null if Evaluate was never reached. */
  result: {
    fitnessVector: FitnessVector;
    aggregate: number;
    /** Fitness components that were NOT observed — they carry the neutral
     *  0.5 placeholder, which is otherwise indistinguishable from a real
     *  measurement of 0.5. The full key list means this candidate was never
     *  evaluated against anything: the row is bookkeeping, not evidence.
     *  Optional because rows written before this field existed have none. */
    unmeasured?: string[];
    /** Confidence-gate verdict in [0, 1]. */
    confidence: number;
    tier0: "passed" | "failed";
    tier1: "no_regression" | "regression";
  } | null;
  /** Terminal decision from the Remember stage. */
  decided: JournalDecision;
  /** Remaining budget at cycle end (BRSI §2.5). */
  budgetRemaining: BudgetRemaining;
  /** Chain fields (G-INV-4) — writer-owned, set by `appendJournal`.
   *  `prevHash` = previous row's `hash` (or "GENESIS");
   *  `hash` = sha256(prevHash || 0x02 || canonical(row-without-chain-fields)).
   *  Absent on pre-L5 legacy rows. */
  prevHash?: string;
  hash?: string;
}

/** Default journal directory. Mirrors `dream-telemetry.ts` pattern at
 *  `~/.feral/rsi/dream.jsonl`. Delegates to `instance-paths.ts` so
 *  the per-instance split (BRSI §3.3) is a one-file change. */
export function defaultJournalDir(): string {
  return paths().journalDir;
}

/** Per-day filename: `journal-2026-07-14.jsonl`. UTC date components
 *  so the file boundary is stable across machines in different time
 *  zones. */
export function journalFilename(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `journal-${y}-${m}-${d}.jsonl`;
}

/** Default full path for a given date. New entries for the current day
 *  go into the same file; the file rotates at UTC midnight. */
export function defaultJournalPath(date: Date = new Date()): string {
  return join(defaultJournalDir(), journalFilename(date));
}

/** Append one JournalEntry as a single JSONL line. Best-effort:
 *  swallows ALL errors so a disk failure cannot abort a dream cycle.
 *  Mirrors `appendDreamTelemetry` discipline (`dream-telemetry.ts:33-44`).
 *
 *  Creates the parent directory on demand; opens with `O_APPEND` which
 *  is atomic-enough for a single-process writer. The engine emits one
 *  cycle at a time so there is no contention. */
export function appendJournal(path: string, entry: JournalEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Chain fields are writer-owned: recompute, never trust the caller.
    const { prevHash: _p, hash: _h, ...body } = entry;
    const prevHash = lastChainHash(path);
    const hash = chainHash(prevHash, body);
    appendFileSync(path, JSON.stringify({ ...body, prevHash, hash }) + "\n", "utf8");
  } catch {
    // Intentionally swallowed — see the file header. A failed journal
    // append is observable only via the missing row in the next read;
    // it never crashes the live engine.
  }
}

/** The `hash` of the file's last row, or GENESIS for a missing/empty
 *  file or a legacy (unchained) tail — the chain (re)starts there.
 *  ponytail: re-reads the whole file per append; per-day files are
 *  tens-of-rows small, cache a Map<path,hash> if that ever changes. */
function lastChainHash(path: string): string {
  if (!existsSync(path)) return GENESIS;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last) return GENESIS;
  try {
    const row = JSON.parse(last) as { hash?: unknown };
    return typeof row.hash === "string" ? row.hash : GENESIS;
  } catch {
    return GENESIS;
  }
}

/** Result of walking one journal file's chain. */
export type JournalVerifyResult =
  | { ok: true; entries: number; legacy: number }
  | { ok: false; badRow: number; reason: string };

/** Verify a journal file's hash chain (G-INV-4). Mirrors
 *  `AuditLog.verify()`: legacy rows before the chain begins pass as
 *  legacy; a break names the first bad row (1-based over non-blank
 *  lines). Never throws — a malformed row is a verification failure. */
export function verifyJournal(path: string): JournalVerifyResult {
  if (!existsSync(path)) return { ok: true, entries: 0, legacy: 0 };
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  let prev = GENESIS;
  let started = false;
  let entries = 0;
  let legacy = 0;
  for (let i = 0; i < lines.length; i++) {
    const badRow = i + 1;
    let row: Record<string, unknown>;
    try {
      const parsed = JSON.parse(lines[i]!) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      row = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, badRow, reason: "malformed row" };
    }
    if (typeof row.hash !== "string") {
      if (started) {
        return { ok: false, badRow, reason: "unchained row after the chain started" };
      }
      legacy++;
      continue;
    }
    if (!started) {
      if (row.prevHash !== GENESIS) {
        return { ok: false, badRow, reason: "chain does not start at GENESIS (head row deleted?)" };
      }
      started = true;
    }
    if (row.prevHash !== prev) {
      return { ok: false, badRow, reason: "prevHash linkage broken (row deleted or reordered)" };
    }
    const { prevHash: _p, hash, ...body } = row;
    if (chainHash(prev, body) !== hash) {
      return { ok: false, badRow, reason: "hash mismatch (row content altered)" };
    }
    prev = hash as string;
    entries++;
  }
  return { ok: true, entries, legacy };
}

/** Read all entries from a single journal file. Returns [] for a
 *  missing file. **Throws** on malformed JSON — a corrupt row is a
 *  signal worth surfacing, unlike a write failure which is recoverable.
 *  (The caller decides whether to log-and-continue or escalate.) */
export function readJournal(path: string): JournalEntry[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as unknown;
    if (isJournalEntry(parsed)) out.push(parsed);
  }
  return out;
}

/** Type guard for parsed JSONL rows. Keeps the read-side safe from
 *  malformed or stale-schema entries. Field presence + primitive type
 *  checks; deeper validation is the consumer's responsibility. */
function isJournalEntry(value: unknown): value is JournalEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.cycleId !== "string") return false;
  if (typeof v.timestamp !== "number") return false;
  if (typeof v.durationMin !== "number") return false;
  if (!Array.isArray(v.observed)) return false;
  if (!Array.isArray(v.hypothesized)) return false;
  if (!v.decided || typeof v.decided !== "object") return false;
  if (!v.budgetRemaining || typeof v.budgetRemaining !== "object") return false;
  return true;
}