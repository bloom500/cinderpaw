/**
 * Faza 6 (L6) Meta Evolution — unit tests for the MetaGenome engine:
 * bounds discipline, deterministic mutation, journal-window fitness,
 * the epoch ratchet (accept / reject+revert), manual rollback, and the
 * append-only history.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
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
} from "../src/rsi/meta-evolution.ts";
import type { JournalEntry } from "../src/rsi/journal.ts";

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
  experimented: null,
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
    expect(metaFitness(Array(MIN_META_CYCLES - 1).fill(cycle("accept", 0.8)))).toBeNull();
  });

  test("rewards accepts + high scores, punishes halts", () => {
    const good = metaFitness([
      cycle("accept", 0.9), cycle("accept", 0.8), cycle("accept", 0.85),
      cycle("accept", 0.9), cycle("reject", 0.7),
    ])!;
    const bad = metaFitness([
      cycle("halt", 0), cycle("halt", 0), cycle("halt", 0),
      cycle("halt", 0), cycle("reject", 0.1),
    ])!;
    expect(good.score).toBeGreaterThan(bad.score);
    expect(good.acceptRate).toBeCloseTo(4 / 5);
    expect(bad.haltRate).toBeCloseTo(4 / 5);
  });
});

describe("MetaEvolution epoch ratchet", () => {
  /** A journal window of MIN_META_CYCLES identical cycles. */
  const win = (action: "accept" | "reject" | "halt", aggregate: number): JournalEntry[] =>
    Array.from({ length: MIN_META_CYCLES }, (_, i) => cycle(action, aggregate, 1_000 + i));

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
    // After revert, a NEW candidate is proposed from the restored champion —
    // the rejected candidate's genome must not be the new baseline.
    const rollbackRow = me.history().find((h) => h.event === "rollback");
    expect(rollbackRow?.genome).toEqual(DEFAULT_META_GENOME);
    expect(me.current()).not.toEqual(candidate);
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
    Array.from({ length: MIN_META_CYCLES }, (_, i) => cycle(action, aggregate, 1_000 + i));

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
