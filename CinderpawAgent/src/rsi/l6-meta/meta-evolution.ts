/**
 * Faza 6 (L6) — Meta Evolution: the engine that optimises the BRSI
 * engine's own strategy.
 *
 * The unit of evolution is the `MetaGenome` — a small, bounded set of
 * metaparameters that steer *how* the lower layers search (mutation
 * magnitude, exploration, gate strictness, dream batch size, selection
 * pressure). It rides the exact same pattern as L1:
 *
 *   current → clone → mutate ONE field → observe (dream cycles under the
 *   candidate) → score from the Evolution Journal → strict-greater
 *   ratchet → accept / rollback.
 *
 * Because a meta-genome can only be evaluated by *living under it* for a
 * while, the loop is epoch-based: `evolve()` first settles the pending
 * candidate (accept if its journal-window fitness strictly beats the
 * recorded baseline, else revert), then proposes + deploys the next
 * candidate. No synchronous eval suite — the evaluator IS the journal.
 *
 * Fitness (aggregate, BRSI L6): more accepted candidates + higher mean
 * aggregate score + fewer halts across the cycles observed under the
 * genome. A genome with fewer than MIN_META_CYCLES observed cycles has
 * no fitness — `evolve()` refuses rather than mutate blind.
 *
 * Safety / Runtime Invariants:
 *   - Only the fixed metaparameter keys exist; the loader clamps every
 *     field to the hardcoded META_BOUNDS, so a hand-edited or corrupt
 *     state file cannot escape the box.
 *   - `confidence_gate` is tighten-only: its lower bound equals the
 *     locked strict gate (BRSI §9 #4). L6 can make the gate stricter,
 *     never weaker. The consumers in sidecar.ts apply max()/min() again.
 *   - History is an append-only JSONL (one MetaGeneration row per deploy
 *     / accept / rollback, with parent, diff, seed, evaluator) — full
 *     replay, same discipline as the Evolution Journal.
 *   - Rollback is always possible: the baseline genome travels in the
 *     state file, and the history keeps every prior generation.
 *
 * Pure-ish: fs writes go under an injectable dir; time + rng injectable.
 * ponytail: one genetic strategy inline — a MetaStrategy plugin interface
 * when a second algorithm (CMA-ES/bandit) actually lands.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../../atomic-write.ts";
import { dirname, join } from "node:path";
import { paths } from "../infra/instance-paths.ts";
import {
  defaultJournalDir,
  journalFilename,
  readJournal,
  verifyJournal,
  type JournalEntry,
} from "../infra/journal.ts";
import { appendGovernanceAudit } from "../l5-gov/governance-audit.ts";
// Type-only: erased at runtime, so no import cycle with governance.ts
// (which imports META_BOUNDS from here).
import type { GovernancePolicy } from "../l5-gov/governance.ts";

/** The ADN of the BRSI engine. Every field is a bounded metaparameter;
 *  none of them can name code, prompts, policies or paths. */
export interface MetaGenome {
  /** Scales the L1 mutation grammar sigmas (as a ratio to the default). */
  mutation_rate: number;
  /** Scales the wild-explorer fraction (as a ratio to the default). */
  exploration: number;
  /** Confidence-gate strictness. LOWER BOUND = the locked strict gate
   *  (0.95) — tighten-only, per the L6 safety rules. */
  confidence_gate: number;
  /** Dream-episode iteration budget (L1 candidates per episode). */
  dream_batch: number;
  /** Scales the L1 roulette selection pressure (ratio to the default). */
  selection_pressure: number;
}

/** Neutral defaults: at generation 0 every ratio-consumer multiplies by
 *  exactly 1 and dream_batch equals the episode default — deploying L6
 *  changes nothing until the first accepted mutation. */
export const DEFAULT_META_GENOME: MetaGenome = {
  mutation_rate: 0.18,
  exploration: 0.12,
  confidence_gate: 0.95,
  dream_batch: 40,
  selection_pressure: 0.4,
};

/** Hard bounds — immutable, hardcoded, applied on every load AND every
 *  mutation. The genome file cannot widen them. */
export const META_BOUNDS: Record<keyof MetaGenome, [number, number]> = {
  mutation_rate: [0.01, 0.8],
  exploration: [0.01, 0.5],
  confidence_gate: [0.95, 0.995], // floor = locked strict gate (BRSI §9 #4)
  dream_batch: [5, 100],
  selection_pressure: [0.1, 3.0],
};

/** Integral fields (rounded after clamp). */
const INTEGRAL: ReadonlySet<keyof MetaGenome> = new Set(["dream_batch"]);

const clamp = (v: number, [lo, hi]: [number, number]): number => Math.min(hi, Math.max(lo, v));

/** Clamp every field into META_BOUNDS, drop unknown keys, fall back to
 *  the default for missing / non-numeric fields. The single door every
 *  genome passes through before it can steer anything. */
export function clampMetaGenome(raw: unknown): MetaGenome {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_META_GENOME };
  for (const key of Object.keys(META_BOUNDS) as (keyof MetaGenome)[]) {
    const v = src[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      const c = clamp(v, META_BOUNDS[key]);
      out[key] = INTEGRAL.has(key) ? Math.round(c) : c;
    }
  }
  return out;
}

/** Deterministic PRNG (mulberry32) — the recorded seed makes every
 *  mutation replayable from its MetaGeneration row. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MetaMutation {
  child: MetaGenome;
  field: keyof MetaGenome;
  /** Human-readable diff, e.g. "mutation_rate: 0.18 → 0.211". */
  diff: string;
}

/** Mutate exactly ONE field (uniform pick) by a ±20% relative jitter,
 *  clamped to bounds — same one-field attribution discipline as L1's
 *  `mutateConfig`, same jitter shape as PBT's `perturb`. */
export function mutateMetaGenome(
  parent: MetaGenome,
  seed: number,
  bounds: Record<keyof MetaGenome, [number, number]> = META_BOUNDS,
): MetaMutation {
  const rng = mulberry32(seed);
  const fields = Object.keys(META_BOUNDS) as (keyof MetaGenome)[];
  const field = fields[Math.min(fields.length - 1, Math.floor(rng() * fields.length))]!;
  const factor = 1 + 0.2 * (rng() * 2 - 1);
  const [, hi] = bounds[field];
  let v = clamp(parent[field] * factor, bounds[field]);
  if (INTEGRAL.has(field)) v = Math.round(v);
  // Clamping / rounding can land back on the parent (small integers, or a
  // parent sitting on a bound) — mirror the jitter toward the interior so
  // a mutation is never a silent no-op.
  if (v === parent[field]) {
    if (INTEGRAL.has(field)) {
      v = parent[field] + 1 > hi ? parent[field] - 1 : parent[field] + 1;
    } else {
      v = clamp(parent[field] * (2 - factor), bounds[field]);
    }
    v = clamp(v, bounds[field]);
  }
  const child = { ...parent, [field]: v };
  return { child, field, diff: `${field}: ${round4(parent[field])} → ${round4(v)}` };
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** Effective mutation bounds (§7): intersect the hardcoded META_BOUNDS
 *  wall with the policy's meta bounds — policy can only narrow. A
 *  degenerate intersection falls back to the wall. */
function effectiveBounds(
  pol: GovernancePolicy | undefined,
): Record<keyof MetaGenome, [number, number]> {
  if (!pol) return META_BOUNDS;
  const out = {} as Record<keyof MetaGenome, [number, number]>;
  for (const key of Object.keys(META_BOUNDS) as (keyof MetaGenome)[]) {
    const wall = META_BOUNDS[key];
    const b = pol.meta.bounds[key] ?? wall;
    const lo = Math.max(b[0], wall[0]);
    const hi = Math.min(b[1], wall[1]);
    out[key] = lo <= hi ? [lo, hi] : [wall[0], wall[1]];
  }
  return out;
}

// ── Fitness ────────────────────────────────────────────────────────────────

/** Minimum journal cycles observed under a genome before it can be
 *  scored. Below this, evolve() refuses — no mutation without evidence. */
export const MIN_META_CYCLES = 5;

/** Acceptance margin: a candidate must beat its baseline by MORE than
 *  this, not merely strictly. Baseline and candidate are measured over
 *  DIFFERENT time windows (different workloads, different luck), so a
 *  bare strict-greater degenerates into a ~50% coin flip under pure
 *  noise and the metaparams random-walk their bounds. The margin makes
 *  noise-driven acceptance require noise > 0.02 aggregate — cheap
 *  insurance against long-term drift until a paired test exists. */
export const META_ACCEPT_MARGIN = 0.02;

export interface MetaFitness {
  /** Aggregate in [0, 1]. */
  score: number;
  /** Cycles the score was computed over. */
  cycles: number;
  acceptRate: number;
  meanAggregate: number;
  haltRate: number;
  /** Accepts whose evaluation was clean (tier0 passed, tier1 no regression). */
  soundAcceptRate: number;
  /** Accepts made ANYWAY over a failed or regressed evaluation. */
  recklessAcceptRate: number;
}

/**
 * Aggregate fitness over the journal window (BRSI L6).
 *
 * The engine is fitter when it accepts candidates that DESERVED to be
 * accepted, when mean scores are higher, and when fewer cycles halt.
 *
 * The middle clause is the correction. This used to reward `acceptRate`
 * flat — accepting more, full stop — so the fittest genome was simply the
 * most permissive one, and an engine that waved through a candidate whose own
 * evaluation reported a regression scored the same as one that was right.
 * Over enough generations that selects for a rubber stamp, which is the
 * meta-level version of an agent that never surfaces a caveat.
 *
 * An accept is SOUND when the evaluation behind it was clean (tier0 passed,
 * tier1 no regression) and RECKLESS otherwise. Sound accepts pay exactly what
 * accepts used to pay; reckless ones now cost more than they earn, so the
 * permissive genome loses to the accurate one instead of tying with it.
 *
 * Deliberately shaped so it is a NO-OP for an engine that was already behaving
 * — with zero reckless accepts the score is identical to the previous formula.
 * That matters because this function selects the genome of a self-modifying
 * loop: a change that moves every score is a change whose blast radius nobody
 * can bound from a unit test.
 *
 * The anti-halt term is kept: an engine that halts every cycle makes no
 * progress, and that IS a failure, distinct from declining a bad candidate
 * (which is a `reject`, not a `halt`, and costs nothing here).
 *
 * All reported components live in [0, 1] and `score` is clamped to it.
 */
export function metaFitness(entries: readonly JournalEntry[]): MetaFitness | null {
  if (entries.length < MIN_META_CYCLES) return null;
  const n = entries.length;
  const accepted = entries.filter((e) => e.decided.action === "accept");
  const halts = entries.filter((e) => e.decided.action === "halt").length;
  const scored = entries.filter((e) => e.result != null);
  const meanAggregate =
    scored.length === 0
      ? 0
      : scored.reduce((s, e) => s + clamp(e.result!.aggregate, [0, 1]), 0) / scored.length;

  // An accept with NO evaluation at all is reckless too: nothing established
  // that the change was safe, which is the situation this term exists for.
  const sound = accepted.filter(
    (e) => e.result != null && e.result.tier0 === "passed" && e.result.tier1 === "no_regression",
  ).length;
  const reckless = accepted.length - sound;

  const acceptRate = accepted.length / n;
  const soundAcceptRate = sound / n;
  const recklessAcceptRate = reckless / n;
  const haltRate = halts / n;
  const score = clamp(
    0.4 * soundAcceptRate + 0.4 * meanAggregate + 0.2 * (1 - haltRate) - 0.4 * recklessAcceptRate,
    [0, 1],
  );
  return {
    score: round4(score),
    cycles: n,
    acceptRate: round4(acceptRate),
    meanAggregate: round4(meanAggregate),
    haltRate: round4(haltRate),
    soundAcceptRate: round4(soundAcceptRate),
    recklessAcceptRate: round4(recklessAcceptRate),
  };
}

// ── Persistence + provenance ───────────────────────────────────────────────

/** One append-only history row per deploy / accept / rollback. */
export interface MetaGeneration {
  generation: number;
  parent: number | null;
  timestamp: number;
  event: "bootstrap" | "proposed" | "accepted" | "rejected" | "rollback";
  /** Fitness score behind the decision; null for proposals (not yet lived). */
  score: number | null;
  diff: string;
  reason: string;
  evaluator: string;
  /** PRNG seed of the mutation that created this genome (replay). */
  seed: number | null;
  genome: MetaGenome;
}

const EVALUATOR = "journal-window-v1";

/** IPC payload shape for `meta_result` events: always `ok`, op-specific rest. */
export type MetaResultPayload = { ok: boolean; [key: string]: unknown };

interface MetaState {
  version: 1;
  generation: number;
  genome: MetaGenome;
  /** Epoch-ms the current genome started steering. */
  deployedAt: number;
  /** Present while the current genome is an unsettled candidate: the
   *  champion it must strictly beat, and where rollback returns to. */
  baseline: { generation: number; genome: MetaGenome; score: number } | null;
}

export interface MetaEvolutionOpts {
  /** State dir override (tests). Default: `~/.cinderpaw/rsi/`. */
  dir?: string;
  now?: () => number;
  /** Journal window reader override (tests). Default: last 7 UTC days
   *  of journal files, filtered to entries at/after `sinceMs`. */
  readWindow?: (sinceMs: number) => JournalEntry[];
  /** Like `readWindow` but also reporting how many journal rows were
   *  excluded by hash-chain verification (G-INV-4). Takes precedence
   *  over `readWindow` when both are given. */
  readWindowVerified?: (sinceMs: number) => { entries: JournalEntry[]; excludedRows: number };
  /** Mutation seed source (tests). Default: 32-bit random. */
  seedSource?: () => number;
  /** L5 governance accessor (§7): frozen.l6 freezes evolve/rollback and
   *  policy meta knobs compose tighten-only on the hardcoded walls.
   *  Absent → pre-L5 behavior (the live sidecar always passes one). */
  policy?: () => GovernancePolicy;
  log?: (msg: string) => void;
}

/** Read the journal window the fitness is computed over: every entry
 *  written since `sinceMs`, across the per-day files of the last 7 UTC
 *  days. Malformed files are skipped (a corrupt day must not brick L6).
 *  G-INV-4: a day-file that fails hash-chain verification is EXCLUDED
 *  from the window and surfaced via `onBadFile` — fitness may only
 *  consume verified evidence (L5 spec §2.4). `excludedRows` counts the
 *  rows lost to failed files so the caller can apply the §9-row-4
 *  "≥ half the window unverified → refuse to settle" floor. */
export function defaultReadWindowVerified(
  sinceMs: number,
  now: number = Date.now(),
  opts: { dir?: string; onBadFile?: (path: string, reason: string) => void } = {},
): { entries: JournalEntry[]; excludedRows: number } {
  const dir = opts.dir ?? defaultJournalDir();
  const out: JournalEntry[] = [];
  let excludedRows = 0;
  for (let i = 0; i < 7; i++) {
    const day = new Date(now - i * 86_400_000);
    const path = join(dir, journalFilename(day));
    const verdict = verifyJournal(path);
    if (!verdict.ok) {
      excludedRows += countRows(path);
      opts.onBadFile?.(path, `row ${verdict.badRow}: ${verdict.reason}`);
      continue;
    }
    try {
      out.push(...readJournal(path));
    } catch {
      // readJournal throws on malformed JSON — skip the day, keep going.
    }
  }
  return {
    entries: out.filter((e) => e.timestamp >= sinceMs).sort((a, b) => a.timestamp - b.timestamp),
    excludedRows,
  };
}

/** Row count of a (possibly corrupt) journal file — best-effort, for
 *  the §9-row-4 lost-evidence accounting only. */
function countRows(path: string): number {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** Back-compat wrapper over `defaultReadWindowVerified`. */
export function defaultReadWindow(
  sinceMs: number,
  now: number = Date.now(),
  opts: { dir?: string; onBadFile?: (path: string, reason: string) => void } = {},
): JournalEntry[] {
  return defaultReadWindowVerified(sinceMs, now, opts).entries;
}

export class MetaEvolution {
  private readonly statePath: string;
  private readonly historyPath: string;
  /** Where the L5 chained audit mirror lives (G-INV-5). */
  private readonly governanceDir: string;
  private readonly now: () => number;
  private readonly readWindowEx: (sinceMs: number) => { entries: JournalEntry[]; excludedRows: number };
  /** L5 policy accessor — null in pre-L5 construction (tests/legacy). */
  private readonly policy: (() => GovernancePolicy) | null;
  private readonly seedSource: () => number;
  private readonly log: (msg: string) => void;
  private state: MetaState;

  constructor(opts: MetaEvolutionOpts = {}) {
    const dir = opts.dir ?? paths().root;
    this.statePath = join(dir, "meta_genome.json");
    this.historyPath = join(dir, "meta_history.jsonl");
    this.governanceDir = join(dir, "governance");
    this.now = opts.now ?? Date.now;
    const legacyWindow = opts.readWindow;
    this.readWindowEx =
      opts.readWindowVerified ??
      (legacyWindow
        ? (since) => ({ entries: legacyWindow(since), excludedRows: 0 })
        : (since) =>
            defaultReadWindowVerified(since, this.now(), {
              onBadFile: (path, reason) =>
                this.log(`[meta] journal verification failed, day excluded (G-INV-4): ${path} (${reason})`),
            }));
    this.policy = opts.policy ?? null;
    this.seedSource = opts.seedSource ?? (() => Math.floor(Math.random() * 0xffffffff));
    this.log = opts.log ?? (() => {});
    this.state = this.load();
  }

  /** The live genome — the accessor the sidecar's selection getters and
   *  gate thresholds read on every use. Cheap: in-memory, this instance
   *  is the only in-process writer. */
  current(): MetaGenome {
    return this.state.genome;
  }

  /** Snapshot for `cinderpaw meta status` / GET /meta/current: genome,
   *  generation, live fitness-so-far, and whether a candidate is pending. */
  status(): MetaResultPayload {
    const fitness = metaFitness(this.readWindowEx(this.state.deployedAt).entries);
    return {
      ok: true,
      generation: this.state.generation,
      genome: this.state.genome,
      deployedAt: this.state.deployedAt,
      pendingCandidate: this.state.baseline !== null,
      baselineScore: this.state.baseline?.score ?? null,
      fitness,
    };
  }

  /** One meta-ratchet epoch: settle the pending candidate (accept iff
   *  its window fitness strictly beats the baseline, else revert), then
   *  propose + deploy the next mutated candidate. Refuses without
   *  MIN_META_CYCLES of journal evidence under the current genome. */
  evolve(): MetaResultPayload {
    const pol = this.policy?.();
    if (pol?.frozen.l6) {
      return { ok: false, reason: "frozen by governance (frozen.l6) — see cinderpaw governance status" };
    }
    const { entries, excludedRows } = this.readWindowEx(this.state.deployedAt);
    // §9 row 4: with ≥ half the window unverified there is not enough
    // trustworthy evidence to settle a candidate — refuse outright.
    if (excludedRows > 0 && excludedRows >= entries.length) {
      return {
        ok: false,
        reason: `insufficient verified evidence: ${excludedRows} journal rows failed hash-chain verification vs ${entries.length} verified (G-INV-4)`,
      };
    }
    const fitness = metaFitness(entries);
    // Policy may demand MORE evidence than the hardcoded floor (§7).
    const minCycles = Math.max(MIN_META_CYCLES, Math.round(pol?.meta.minCycles ?? 0));
    if (!fitness || fitness.cycles < minCycles) {
      return {
        ok: false,
        reason: `insufficient evidence: need >= ${minCycles} dream cycles under the current meta-genome before evolving`,
      };
    }

    let settled: "accepted" | "rejected" | "bootstrap" = "bootstrap";
    let championScore = fitness.score;

    // Policy margin composes tighten-only on the hardcoded floor (§7).
    const acceptMargin = Math.max(META_ACCEPT_MARGIN, pol?.meta.acceptMargin ?? 0);

    if (this.state.baseline) {
      // The meta-ratchet: strict-greater BY MARGIN (see META_ACCEPT_MARGIN —
      // the two windows are not paired, so bare > is a coin flip on noise).
      if (fitness.score > this.state.baseline.score + acceptMargin) {
        settled = "accepted";
        this.append("accepted", fitness.score, `beat baseline ${this.state.baseline.score}`, null, this.state.genome);
      } else {
        settled = "rejected";
        championScore = this.state.baseline.score;
        this.append(
          "rejected",
          fitness.score,
          `did not beat baseline ${this.state.baseline.score} — reverting to generation ${this.state.baseline.generation}`,
          null,
          this.state.genome,
        );
        this.state = {
          ...this.state,
          generation: this.state.generation + 1,
          genome: this.state.baseline.genome,
          deployedAt: this.now(),
          baseline: null,
        };
        this.append("rollback", championScore, "auto-revert after rejected candidate", null, this.state.genome);
      }
    }

    // Propose the next candidate from the settled champion.
    const seed = this.seedSource() >>> 0;
    const champion = this.state.genome;
    const championGen = this.state.generation;
    const { child, diff } = mutateMetaGenome(champion, seed, effectiveBounds(pol));
    this.state = {
      version: 1,
      generation: championGen + 1,
      genome: child,
      deployedAt: this.now(),
      baseline: { generation: championGen, genome: champion, score: championScore },
    };
    this.append("proposed", null, `candidate over generation ${championGen} (${settled})`, seed, child, diff);
    this.save();
    // G-INV-5: one chained governance-audit row per evolve() epoch.
    appendGovernanceAudit(this.governanceDir, {
      timestamp: this.now(),
      source: "l6",
      event: "evolve",
      refId: `gen-${this.state.generation}`,
      summary: `${settled} → proposed generation ${this.state.generation} (${diff})`,
    });
    this.log(`meta-evolution: ${settled} → proposed generation ${this.state.generation} (${diff})`);
    return {
      ok: true,
      settled,
      previousFitness: fitness,
      generation: this.state.generation,
      diff,
      genome: child,
    };
  }

  /** Manual rollback: drop the pending candidate and return to its
   *  baseline champion. Errors when there is nothing pending. */
  rollback(): MetaResultPayload {
    if (this.policy?.().frozen.l6) {
      return { ok: false, reason: "frozen by governance (frozen.l6) — see cinderpaw governance status" };
    }
    if (!this.state.baseline) {
      return { ok: false, reason: "no pending candidate — nothing to roll back" };
    }
    const { genome, generation, score } = this.state.baseline;
    this.state = {
      version: 1,
      generation: this.state.generation + 1,
      genome,
      deployedAt: this.now(),
      baseline: null,
    };
    this.append("rollback", score, `manual rollback to generation ${generation}`, null, genome);
    this.save();
    // G-INV-5: one chained governance-audit row per rollback.
    appendGovernanceAudit(this.governanceDir, {
      timestamp: this.now(),
      source: "l6",
      event: "rollback",
      refId: `gen-${this.state.generation}`,
      summary: `manual rollback to generation ${generation}`,
    });
    this.log(`meta-evolution: manual rollback to generation ${generation}`);
    return { ok: true, generation: this.state.generation, genome };
  }

  /** The append-only history, newest last. Skips unparseable lines —
   *  one corrupt row must not hide the rest of the provenance. */
  history(limit = 50): MetaGeneration[] {
    if (!existsSync(this.historyPath)) return [];
    let text: string;
    try {
      text = readFileSync(this.historyPath, "utf8");
    } catch {
      return [];
    }
    const rows: MetaGeneration[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as MetaGeneration);
      } catch {
        // skip the bad row, keep the rest
      }
    }
    return rows.slice(-limit);
  }

  // ── internals ──────────────────────────────────────────────────────────

  private load(): MetaState {
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<MetaState>;
      const baseline =
        raw.baseline && typeof raw.baseline.score === "number"
          ? {
              generation: raw.baseline.generation ?? 0,
              genome: clampMetaGenome(raw.baseline.genome),
              score: raw.baseline.score,
            }
          : null;
      return {
        version: 1,
        generation: typeof raw.generation === "number" ? raw.generation : 0,
        genome: clampMetaGenome(raw.genome),
        deployedAt: typeof raw.deployedAt === "number" ? raw.deployedAt : this.now(),
        baseline,
      };
    } catch {
      // Missing OR corrupt state → neutral defaults, but the generation
      // counter resumes from the history's max + 1: a corrupt file must
      // never silently reset provenance to duplicate generation numbers.
      const corrupt = existsSync(this.statePath);
      const prior = this.history(Number.MAX_SAFE_INTEGER);
      const generation = prior.length
        ? Math.max(...prior.map((r) => r.generation)) + (corrupt ? 1 : 0)
        : 0;
      const state: MetaState = {
        version: 1,
        generation,
        genome: { ...DEFAULT_META_GENOME },
        deployedAt: this.now(),
        baseline: null,
      };
      // `append` reads this.state — set it before writing the row
      // (load runs from the constructor, before the field assignment).
      this.state = state;
      this.append(
        "bootstrap",
        null,
        corrupt
          ? `state file unreadable — recovered to neutral defaults at generation ${generation}`
          : "generation 0 — neutral defaults",
        null,
        state.genome,
      );
      this.persist(state);
      return state;
    }
  }

  private save(): void {
    this.persist(this.state);
  }

  private persist(state: MetaState): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      // Atomic: write a sibling temp file, fsync, then rename over the target.
      // A crash mid-write leaves the old state intact instead of a truncated
      // JSON that would trigger the corrupt-recovery path. The temp name now
      // carries the pid, so two writers cannot land on the same one.
      atomicWriteFileSync(this.statePath, JSON.stringify(state, null, 2));
    } catch (e) {
      this.log(`meta-evolution: failed to persist state: ${String(e)}`);
    }
  }

  private append(
    event: MetaGeneration["event"],
    score: number | null,
    reason: string,
    seed: number | null,
    genome: MetaGenome,
    diff = "",
  ): void {
    const row: MetaGeneration = {
      generation: this.state.generation,
      parent: this.state.baseline?.generation ?? (this.state.generation > 0 ? this.state.generation - 1 : null),
      timestamp: this.now(),
      event,
      score,
      diff,
      reason,
      evaluator: EVALUATOR,
      seed,
      genome,
    };
    try {
      mkdirSync(dirname(this.historyPath), { recursive: true });
      appendFileSync(this.historyPath, JSON.stringify(row) + "\n", "utf8");
    } catch {
      // Best-effort, same discipline as the Evolution Journal.
    }
  }
}
