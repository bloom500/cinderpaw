/**
 * Evolution spec S0.1: L6 rolls back to any recorded generation, durably,
 * and a lost state file recovers the last settled genome from the history.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinFailClosedPolicy, defaultGenesisPolicy } from "../src/rsi/l5-gov/governance.ts";
import { DEFAULT_META_GENOME, MetaEvolution, MIN_META_CYCLES } from "../src/rsi/l6-meta/meta-evolution.ts";
import type { JournalEntry } from "../src/rsi/infra/journal.ts";

/** One accepted candidate row plus its episode summary, the shape L6 scores
 *  (same as rsi-meta-evolution.test.ts). */
const acceptedEpisode = (aggregate: number, timestamp: number): JournalEntry[] => {
  const row: JournalEntry = {
    cycleId: `c-${timestamp}`,
    timestamp,
    durationMin: 1,
    observed: [],
    hypothesized: [],
    experimented: { candidateId: `g-${timestamp}`, change: "", layer: "L1" },
    result: {
      fitnessVector: { accuracy: aggregate, latency: 0, cost: 0, toolSuccess: 1, hallucination: 0, userSatisfaction: 0.5 },
      aggregate,
      confidence: 0.9,
      tier0: "passed",
      tier1: "no_regression",
    },
    decided: { action: "accept", reason: "test" },
    budgetRemaining: { wallClockMin: 1, tokens: 1, cpuPct: 1, ramMb: 1, diskMb: 1 },
  };
  return [row, { ...row, observed: ["trigger: idle"], experimented: null, result: null }];
};

const window = (aggregate: number): JournalEntry[] =>
  Array.from({ length: MIN_META_CYCLES }, (_, i) => acceptedEpisode(aggregate, 1_000 + i)).flat();

/** An engine that accepts every candidate: windows climb 0.1 -> 0.9. */
const climbing = (dir: string, policy = defaultGenesisPolicy) => {
  let call = 0;
  let seed = 11;
  return new MetaEvolution({
    dir,
    now: () => 10_000 + call,
    readWindow: () => window(Math.min(0.1 + 0.2 * call++, 0.99)),
    seedSource: () => seed++,
    policy: () => policy(),
  });
};

/** The person running `cinderpaw meta evolve` (S0.2). */
const op = { approvedBy: "operator" };

const tmp = () => mkdtempSync(join(tmpdir(), "meta-rollback-"));

describe("L6 rollback to any generation (S0.1)", () => {
  test("rolls back to generation 1 of 5 and survives a restart", () => {
    const dir = tmp();
    const me = climbing(dir);
    for (let i = 0; i < 5; i++) expect(me.evolve(op).ok).toBe(true);
    const gen1 = me.history(1_000).findLast((r) => r.generation === 1)!.genome;
    expect(me.current()).not.toEqual(gen1);

    const r = me.rollback(1);
    expect(r.ok).toBe(true);
    expect(me.current()).toEqual(gen1);
    expect(me.history().at(-1)!.reason).toBe("manual rollback to generation 1");
    expect(new MetaEvolution({ dir, readWindow: () => [] }).current()).toEqual(gen1);
  });

  test("an unknown generation or the current one is refused with the reason", () => {
    const me = climbing(tmp());
    me.evolve(op);
    expect(me.rollback(42)).toMatchObject({ ok: false });
    expect(String(me.rollback(42).reason)).toContain("generation 42 is not in the history");
    expect(String(me.rollback(me.status().generation as number).reason)).toContain("already on generation");
  });

  test("frozen L6: refused without a name, allowed and recorded with one; evolve stays refused", () => {
    const dir = tmp();
    const me = climbing(dir);
    me.evolve(op);
    me.evolve(op);
    let frozen = false;
    const guarded = new MetaEvolution({
      dir,
      readWindow: () => window(0.9),
      policy: () => (frozen ? builtinFailClosedPolicy() : defaultGenesisPolicy()),
    });
    frozen = true;
    expect(String(guarded.rollback(0).reason)).toContain("needs the name of the person authorizing it");
    expect(guarded.evolve(op).ok).toBe(false);

    const r = guarded.rollback(0, { authorizedBy: "Darius" });
    expect(r.ok).toBe(true);
    expect(guarded.current()).toEqual(DEFAULT_META_GENOME);
    expect(guarded.history().at(-1)!.reason).toBe("manual rollback to generation 0, authorized by Darius");
    expect(guarded.evolve(op).ok).toBe(false);
  });

  test("a failed write leaves memory and disk unchanged", () => {
    const dir = tmp();
    const me = climbing(dir);
    me.evolve(op);
    me.evolve(op);
    const before = { genome: me.current(), generation: me.status().generation };
    const rows = me.history(1_000).length;
    const statePath = join(dir, "meta_genome.json");
    rmSync(statePath, { force: true });
    mkdirSync(statePath);

    const r = me.rollback(0);
    expect(r.ok).toBe(false);
    expect(String(r.reason)).toContain("nothing changed");
    expect(me.current()).toEqual(before.genome);
    expect(me.status().generation).toBe(before.generation);
    expect(me.history(1_000).length).toBe(rows);
  });

  test("a corrupt state file recovers the last settled generation, not neutral defaults", () => {
    const dir = tmp();
    const me = climbing(dir);
    for (let i = 0; i < 3; i++) me.evolve(op); // gen 1, 2 accepted; gen 3 pending
    const last = me.history(1_000).findLast((r) => r.event === "accepted")!;
    expect(last.genome).not.toEqual(DEFAULT_META_GENOME);
    writeFileSync(join(dir, "meta_genome.json"), "{not json");

    const recovered = new MetaEvolution({ dir, readWindow: () => [] });
    expect(recovered.current()).toEqual(last.genome);
    expect(recovered.status().generation).toBe(4);
    expect(recovered.status().pendingCandidate).toBe(false);
    expect(recovered.history().at(-1)!.reason).toContain(`recovered generation ${last.generation} from the history`);
  });
});

describe("the l6_evolve approval is enforced (S0.2)", () => {
  test("fresh governance refuses an unasked evolve with a readable reason; a named person runs it", () => {
    const fresh = defaultGenesisPolicy();
    expect(fresh.approvals.l6Evolve).toBe(true);
    let seed = 3;
    const me = new MetaEvolution({ dir: tmp(), readWindow: () => window(0.5), seedSource: () => seed++, policy: () => fresh });

    const scheduled = me.evolve();
    expect(scheduled.ok).toBe(false);
    expect(String(scheduled.reason)).toContain("needs a person to start it");
    expect(String(scheduled.reason)).toContain("cinderpaw meta evolve");
    expect(me.status().generation).toBe(0);

    expect(me.evolve({ approvedBy: "operator" }).ok).toBe(true);
    expect(me.status().generation).toBe(1);
  });

  test("a policy that does not demand a human still evolves unasked", () => {
    const open = { ...defaultGenesisPolicy(), approvals: { ...defaultGenesisPolicy().approvals, l6Evolve: false } };
    const me = new MetaEvolution({ dir: tmp(), readWindow: () => window(0.5), policy: () => open });
    expect(me.evolve().ok).toBe(true);
  });
});
