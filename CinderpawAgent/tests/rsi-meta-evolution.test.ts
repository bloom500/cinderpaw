/**
 * Faza 6 (L6) Meta Evolution — unit tests for the MetaGenome engine:
 * bounds discipline, deterministic mutation, journal-window fitness,
 * the epoch ratchet (accept / reject+revert), manual rollback, and the
 * append-only history.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_META_GENOME,
  META_BOUNDS,
  MIN_META_CYCLES,
  MetaEvolution,
  clampMetaGenome,
  metaFitness,
  mutateMetaGenome,
} from "../src/rsi/l6-meta/meta-evolution.ts";
import type { JournalEntry } from "../src/rsi/infra/journal.ts";

const cycle = (
  action: "accept" | "reject" | "halt",
  aggregate: number,
  timestamp = 1_000,
): JournalEntry => ({
  cycleId: `c-${timestamp}`,
  timestamp,
  durationMin: 1,
  observed: [],
  hypothesized: [],
  // A per-candidate row, the shape the Contract FSM writes. (A row with no
  // `experimented` is the episode summary; see the summary-row test below.)
  experimented: { candidateId: `g-${timestamp}`, change: "", layer: "L1" },
  result:
    action === "halt"
      ? null
      : {
          fitnessVector: {
            accuracy: aggregate,
            latency: 0,
            cost: 0,
            toolSuccess: 1,
            hallucination: 0,
            userSatisfaction: 0.5,
          },
          aggregate,
          confidence: 0.9,
          tier0: "passed",
          tier1: "no_regression",
        },
  decided:
    action === "accept"
      ? { action: "accept", reason: "test" }
      : action === "reject"
        ? { action: "reject", reason: "test", nextStep: "n/a" }
        : { action: "halt", reason: "test", stage: "evaluate" },
  budgetRemaining: { wallClockMin: 1, tokens: 1, cpuPct: 1, ramMb: 1, diskMb: 1 },
});

/** The row makeCycleSummary writes once per dream episode: no candidate and
 *  no evaluation of its own. L6 counts its evidence in these. */
const summary = (action: "accept" | "reject" | "halt" = "reject", timestamp = 1_000): JournalEntry => ({
  ...cycle(action, 0, timestamp),
  observed: ["trigger: idle"],
  experimented: null,
  result: null,
});

/** One dream episode per candidate row: the candidate, then its summary. */
const episodes = (...candidates: JournalEntry[]): JournalEntry[] =>
  candidates.flatMap((c) => [c, summary(c.decided.action === "accept" ? "accept" : "reject", c.timestamp)]);

describe("clampMetaGenome", () => {
  test("clamps every field to META_BOUNDS and rounds integral fields", () => {
    const g = clampMetaGenome({
      mutation_rate: 99,
      exploration: -1,
      confidence_gate: 0.5, // below the locked floor
      dream_batch: 7.6,
      selection_pressure: 0,
    });
    expect(g.mutation_rate).toBe(META_BOUNDS.mutation_rate[1]);
    expect(g.exploration).toBe(META_BOUNDS.exploration[0]);
    expect(g.confidence_gate).toBe(0.95); // tighten-only floor holds
    expect(g.dream_batch).toBe(8);
    expect(g.selection_pressure).toBe(META_BOUNDS.selection_pressure[0]);
  });

  test("drops unknown keys and defaults missing / non-numeric fields", () => {
    const g = clampMetaGenome({ evil_code: "rm -rf", mutation_rate: "NaN" }) as Record<
      string,
      unknown
    >;
    expect(g.evil_code).toBeUndefined();
    expect(g.mutation_rate).toBe(DEFAULT_META_GENOME.mutation_rate);
  });
});

describe("mutateMetaGenome", () => {
  test("is deterministic given a seed and changes exactly one field", () => {
    const a = mutateMetaGenome(DEFAULT_META_GENOME, 42);
    const b = mutateMetaGenome(DEFAULT_META_GENOME, 42);
    expect(a).toEqual(b);
    const changed = (Object.keys(DEFAULT_META_GENOME) as (keyof typeof DEFAULT_META_GENOME)[]).filter(
      (k) => a.child[k] !== DEFAULT_META_GENOME[k],
    );
    expect(changed).toEqual([a.field]);
  });

  test("never leaves bounds across many seeds and never no-ops", () => {
    let g = { ...DEFAULT_META_GENOME };
    for (let seed = 0; seed < 500; seed++) {
      const { child, field } = mutateMetaGenome(g, seed);
      expect(child[field]).not.toBe(g[field]);
      for (const k of Object.keys(META_BOUNDS) as (keyof typeof META_BOUNDS)[]) {
        expect(child[k]).toBeGreaterThanOrEqual(META_BOUNDS[k][0]);
        expect(child[k]).toBeLessThanOrEqual(META_BOUNDS[k][1]);
      }
      g = child;
    }
  });
});

describe("metaFitness", () => {
  test("null under MIN_META_CYCLES (no mutation without evidence)", () => {
    expect(metaFitness([])).toBeNull();
    expect(metaFitness(episodes(...Array(MIN_META_CYCLES - 1).fill(cycle("accept", 0.8))))).toBeNull();
  });

  test("rewards accepts + high scores, punishes halts", () => {
    const good = metaFitness(episodes(
      cycle("accept", 0.9), cycle("accept", 0.8), cycle("accept", 0.85),
      cycle("accept", 0.9), cycle("reject", 0.7),
    ))!;
    const bad = metaFitness(episodes(
      cycle("halt", 0), cycle("halt", 0), cycle("halt", 0),
      cycle("halt", 0), cycle("reject", 0.1),
    ))!;
    expect(good.score).toBeGreaterThan(bad.score);
    expect(good.acceptRate).toBeCloseTo(4 / 5);
    expect(bad.haltRate).toBeCloseTo(4 / 5);
  });
});

describe("metaFitness counts episodes, and only L1's", () => {
  test("one episode is not enough evidence, however many candidate rows it wrote", () => {
    // The default dream_batch is 40: a single episode writes up to 41 rows,
    // which used to count as 41 "dream cycles" and settle a generation alone.
    const oneEpisode = [
      ...Array.from({ length: 40 }, (_, i) => cycle("reject", 0.5, i)),
      summary("reject", 40),
    ];
    expect(oneEpisode.length).toBeGreaterThan(MIN_META_CYCLES);
    expect(metaFitness(oneEpisode)).toBeNull();
  });

  test("a smaller dream_batch is not fitter by itself: accepts count per episode", () => {
    // The same improvement (one sound accept per episode) at two batch sizes.
    // Per row, the batch of 10 scored 1/11 against 1/41, and dream_batch is a
    // knob L6 sets itself.
    const batch = (size: number): JournalEntry[] =>
      Array.from({ length: MIN_META_CYCLES }, (_, ep) => [
        cycle("accept", 0.8, ep * 100),
        ...Array.from({ length: size - 1 }, (_, i) => cycle("reject", 0.8, ep * 100 + 1 + i)),
        summary("accept", ep * 100 + 99),
      ]).flat();
    const big = metaFitness(batch(40))!;
    const small = metaFitness(batch(10))!;
    expect(small.acceptRate).toBe(1);
    expect(big.acceptRate).toBe(1);
    expect(small.score).toBe(big.score);
  });

  test("L3 code rows and L4 module rows do not move the fitness of L1's knobs", () => {
    const l1 = episodes(
      cycle("accept", 0.9), cycle("accept", 0.8), cycle("reject", 0.7),
      cycle("reject", 0.7), cycle("reject", 0.6),
    );
    const other = (layer: "L3" | "L4", action: "accept" | "halt", aggregate: number): JournalEntry => ({
      ...cycle(action, aggregate),
      experimented: { candidateId: `${layer}-x`, change: "", layer },
    });
    const mixed = [
      ...l1,
      other("L3", "halt", 0), other("L3", "accept", 0), other("L3", "halt", 0),
      other("L4", "accept", 0.1), other("L4", "halt", 0),
    ];
    expect(metaFitness(mixed)).toEqual(metaFitness(l1));
  });
});

describe("MetaEvolution epoch ratchet", () => {
  /** A journal window of MIN_META_CYCLES identical cycles. */
  const win = (action: "accept" | "reject" | "halt", aggregate: number): JournalEntry[] =>
    episodes(...Array.from({ length: MIN_META_CYCLES }, (_, i) => cycle(action, aggregate, 1_000 + i)));

  const make = (windows: JournalEntry[][]) => {
    const dir = mkdtempSync(join(tmpdir(), "meta-evo-"));
    let call = 0;
    let seed = 7;
    const me = new MetaEvolution({
      dir,
      now: () => 1_000 + call,
      readWindow: () => windows[Math.min(call++, windows.length - 1)] ?? [],
      seedSource: () => seed++,
    });
    return { me, dir };
  };

  test("bootstraps at generation 0 with neutral defaults", () => {
    const { me } = make([[]]);
    expect(me.current()).toEqual(DEFAULT_META_GENOME);
    const s = me.status();
    expect(s.generation).toBe(0);
    expect(s.pendingCandidate).toBe(false);
    expect(me.history()[0]?.event).toBe("bootstrap");
  });

  test("refuses to evolve without enough journal evidence", () => {
    const { me } = make([[cycle("accept", 0.9)]]);
    const r = me.evolve();
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain("insufficient evidence");
    expect(me.status().generation).toBe(0);
  });

  test("evolve proposes a candidate; a better window accepts it", () => {
    const { me } = make([win("reject", 0.5), win("accept", 0.9)]);

    const r1 = me.evolve();
    expect(r1.ok).toBe(true);
    expect(r1.settled).toBe("bootstrap");
    expect(me.status().pendingCandidate).toBe(true);
    expect(me.status().generation).toBe(1);

    const r2 = me.evolve(); // candidate's window beats the baseline → accept
    expect(r2.ok).toBe(true);
    expect(r2.settled).toBe("accepted");
    expect(me.history().some((h) => h.event === "accepted")).toBe(true);
  });

  test("a worse window rejects the candidate and reverts to the baseline", () => {
    const { me } = make([win("accept", 0.9), win("halt", 0)]);

    me.evolve(); // propose candidate (baseline = defaults @ good score)
    const candidate = me.current();
    const r = me.evolve(); // candidate lived through `worse` → reject + revert
    expect(r.settled).toBe("rejected");
    // Reverted to the baseline, and nothing proposed on top: the champion is
    // measured again over a fresh window first (next test).
    const rollbackRow = me.history().find((h) => h.event === "rollback");
    expect(rollbackRow?.genome).toEqual(DEFAULT_META_GENOME);
    expect(me.current()).not.toEqual(candidate);
    expect(me.current()).toEqual(DEFAULT_META_GENOME);
    expect(me.status().pendingCandidate).toBe(false);
  });

  test("after a reject the champion is re-measured before the next proposal", () => {
    // The old baseline was scored over an older window. Later windows ratchet
    // less (the champion gets harder to beat), so comparing every new
    // candidate against that old score drifts toward rejecting everything.
    const fresh = win("reject", 0.5);
    const { me } = make([win("accept", 0.9), win("halt", 0), fresh]);
    me.evolve(); // bootstrap over the 0.9 window, propose generation 1

    const rejected = me.evolve();
    expect(rejected.settled).toBe("rejected");
    expect(rejected.diff).toBeUndefined();
    expect(me.history().at(-1)?.event).toBe("rollback");

    const next = me.evolve(); // the reverted champion's own, fresh window
    expect(next.settled).toBe("bootstrap");
    expect(typeof next.diff).toBe("string");
    expect(me.status().baselineScore).toBe(metaFitness(fresh)!.score);
  });

  test("manual rollback returns to the baseline; errors when nothing pending", () => {
    const { me } = make([win("accept", 0.9)]);
    expect(me.rollback().ok).toBe(false);
    me.evolve();
    const r = me.rollback();
    expect(r.ok).toBe(true);
    expect(me.current()).toEqual(DEFAULT_META_GENOME);
    expect(me.status().pendingCandidate).toBe(false);
  });

  test("a failed state write cancels the epoch: memory stays what the disk says", () => {
    const { me, dir } = make([win("accept", 0.9)]);
    // A directory where the state file should be: the atomic rename fails.
    const statePath = join(dir, "meta_genome.json");
    rmSync(statePath, { force: true });
    mkdirSync(statePath);

    const r = me.evolve();
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain("could not save the meta-genome");
    expect(me.current()).toEqual(DEFAULT_META_GENOME);
    expect(me.status().generation).toBe(0);
    expect(me.status().pendingCandidate).toBe(false);
    expect(me.history().at(-1)?.reason).toContain("cancelled: state file not written");
  });

  test("state persists across instances and history is append-only", () => {
    const w = win("accept", 0.9);
    const { me, dir } = make([w]);
    me.evolve();
    const before = readFileSync(join(dir, "meta_history.jsonl"), "utf8");

    const reloaded = new MetaEvolution({ dir, readWindow: () => w, seedSource: () => 7 });
    expect(reloaded.current()).toEqual(me.current());
    expect(reloaded.status().generation).toBe(1);
    const after = readFileSync(join(dir, "meta_history.jsonl"), "utf8");
    expect(after.startsWith(before)).toBe(true); // nothing rewritten
    expect(reloaded.history().at(-1)?.seed).toBe(7); // replayable provenance
  });

  test("a tampered state file cannot escape the bounds", () => {
    const { me, dir } = make([[]]);
    void me;
    const statePath = join(dir, "meta_genome.json");
    const tampered = {
      version: 1,
      generation: 3,
      genome: { mutation_rate: 999, confidence_gate: 0.01, evil: "x" },
      deployedAt: 0,
      baseline: null,
    };
    require("node:fs").writeFileSync(statePath, JSON.stringify(tampered));
    const reloaded = new MetaEvolution({ dir, readWindow: () => [] });
    expect(reloaded.current().mutation_rate).toBe(META_BOUNDS.mutation_rate[1]);
    expect(reloaded.current().confidence_gate).toBe(0.95);
    expect((reloaded.current() as Record<string, unknown>).evil).toBeUndefined();
  });
});

describe("MetaEvolution hardening (audit fixes)", () => {
  const win = (action: "accept" | "reject" | "halt", aggregate: number): JournalEntry[] =>
    episodes(...Array.from({ length: MIN_META_CYCLES }, (_, i) => cycle(action, aggregate, 1_000 + i)));

  test("a candidate within the acceptance margin is rejected (no noise ratchet)", () => {
    const dir = mkdtempSync(join(tmpdir(), "meta-evo-"));
    const windows = [win("accept", 0.9), win("accept", 0.905)]; // +0.002 < margin
    let call = 0;
    let seed = 7;
    const me = new MetaEvolution({
      dir,
      readWindow: () => windows[Math.min(call++, windows.length - 1)] ?? [],
      seedSource: () => seed++,
    });
    me.evolve(); // propose
    const r = me.evolve(); // barely-better window must NOT clear the margin
    expect(r.settled).toBe("rejected");
  });

  test("a corrupt state file recovers without duplicating generation numbers", () => {
    const dir = mkdtempSync(join(tmpdir(), "meta-evo-"));
    const w = win("accept", 0.9);
    let seed = 7;
    const me = new MetaEvolution({ dir, readWindow: () => w, seedSource: () => seed++ });
    me.evolve(); // generation 1 exists in history
    require("node:fs").writeFileSync(join(dir, "meta_genome.json"), "{not json");

    const recovered = new MetaEvolution({ dir, readWindow: () => w });
    // Resumes past the highest generation in history instead of resetting to 0.
    expect(recovered.status().generation).toBe(2);
    expect(recovered.current()).toEqual(DEFAULT_META_GENOME);
    const last = recovered.history().at(-1)!;
    expect(last.event).toBe("bootstrap");
    expect(last.reason).toContain("recovered");
  });

  test("history() skips a corrupt row instead of hiding everything", () => {
    const dir = mkdtempSync(join(tmpdir(), "meta-evo-"));
    const me = new MetaEvolution({ dir, readWindow: () => [] });
    void me;
    require("node:fs").appendFileSync(join(dir, "meta_history.jsonl"), "garbage-line\n");
    const reloaded = new MetaEvolution({ dir, readWindow: () => [] });
    expect(reloaded.history().some((h) => h.event === "bootstrap")).toBe(true);
  });
});

/**
 * Calibration: the engine is scored on accepts that DESERVED to be accepted,
 * not on accepting more. Before this, `acceptRate` was flat, so the fittest
 * genome was simply the most permissive one and an engine that waved through
 * a regression tied with one that was right.
 */
describe("metaFitness rewards being right, not being permissive", () => {
  /** An accept made over an evaluation that says the change is bad. */
  const recklessAccept = (aggregate: number, timestamp = 1_000): JournalEntry => {
    const e = cycle("accept", aggregate, timestamp);
    return { ...e, result: { ...e.result!, tier0: "failed", tier1: "regression" } };
  };
  /** An accept with no evaluation at all — nothing established it was safe. */
  const blindAccept = (timestamp = 1_000): JournalEntry => ({
    ...cycle("accept", 0.9, timestamp),
    result: null,
  });

  const clean = episodes(
    cycle("accept", 0.9), cycle("accept", 0.8), cycle("accept", 0.85),
    cycle("accept", 0.9), cycle("reject", 0.7),
  );

  test("a clean window is scored exactly as before — the change is a no-op there", () => {
    const f = metaFitness(clean)!;
    // 0.4*(4/5) + 0.4*mean(0.9,0.8,0.85,0.9,0.7) + 0.2*(1-0) - 0.4*0
    const mean = (0.9 + 0.8 + 0.85 + 0.9 + 0.7) / 5;
    expect(f.score).toBeCloseTo(0.4 * 0.8 + 0.4 * mean + 0.2, 4);
    expect(f.recklessAcceptRate).toBe(0);
    expect(f.soundAcceptRate).toBe(f.acceptRate);
  });

  test("accepting over a regression scores WORSE than not accepting at all", () => {
    const reckless = metaFitness(episodes(
      recklessAccept(0.9), recklessAccept(0.8), recklessAccept(0.85),
      recklessAccept(0.9), cycle("reject", 0.7),
    ))!;
    const restrained = metaFitness(episodes(
      cycle("reject", 0.9), cycle("reject", 0.8), cycle("reject", 0.85),
      cycle("reject", 0.9), cycle("reject", 0.7),
    ))!;
    expect(reckless.score).toBeLessThan(restrained.score);
    expect(reckless.recklessAcceptRate).toBeCloseTo(0.8, 4);
    expect(reckless.soundAcceptRate).toBe(0);
  });

  test("the accurate engine beats the permissive one on identical evaluations", () => {
    const accurate = metaFitness(clean)!;
    const permissive = metaFitness(episodes(
      cycle("accept", 0.9), cycle("accept", 0.8), cycle("accept", 0.85),
      cycle("accept", 0.9), recklessAccept(0.7),
    ))!;
    // Both accept a lot; only one of them was right about the last candidate.
    expect(permissive.acceptRate).toBeGreaterThan(accurate.acceptRate);
    expect(permissive.score).toBeLessThan(accurate.score);
  });

  test("an accept with no evaluation counts as reckless", () => {
    const f = metaFitness(episodes(
      blindAccept(), blindAccept(), blindAccept(), blindAccept(), cycle("reject", 0.7),
    ))!;
    expect(f.soundAcceptRate).toBe(0);
    expect(f.recklessAcceptRate).toBeCloseTo(0.8, 4);
  });

  test("an episode summary row does not count its episode's accept a second time", () => {
    // What makeCycleSummary writes after an episode that ratcheted: no
    // candidate, no evaluation, decided "accept" because the candidate row
    // already was. It used to be scored as a reckless accept, cancelling the
    // sound one it summarises.
    const withSummaries = metaFitness([
      cycle("accept", 0.9, 1), summary("accept", 2),
      cycle("accept", 0.8, 3), summary("accept", 4),
      cycle("reject", 0.7, 5), summary("reject", 6),
      cycle("reject", 0.7, 7), summary("reject", 8),
      cycle("reject", 0.7, 9), summary("reject", 10),
    ])!;
    expect(withSummaries.recklessAcceptRate).toBe(0);
    expect(withSummaries.soundAcceptRate).toBeCloseTo(2 / 5, 4);
  });

  test("halting every cycle is still a failure — declining is a reject, not a halt", () => {
    const halting = metaFitness(episodes(
      cycle("halt", 0), cycle("halt", 0), cycle("halt", 0), cycle("halt", 0), cycle("halt", 0),
    ))!;
    const rejecting = metaFitness(episodes(
      cycle("reject", 0.8), cycle("reject", 0.8), cycle("reject", 0.8),
      cycle("reject", 0.8), cycle("reject", 0.8),
    ))!;
    expect(halting.score).toBeLessThan(rejecting.score);
  });

  test("the score stays inside [0, 1] however reckless the engine is", () => {
    const f = metaFitness(episodes(...Array(10).fill(recklessAccept(0))))!;
    expect(f.score).toBeGreaterThanOrEqual(0);
    expect(f.score).toBeLessThanOrEqual(1);
  });
});
