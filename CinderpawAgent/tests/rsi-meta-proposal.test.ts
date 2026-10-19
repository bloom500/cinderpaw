/**
 * L6 asks in chat (19 Oct 2026): after a dream, L6 prepares its next change as
 * a proposal; nothing changes until a person approves that exact proposal on
 * the chat card. A "no" is not asked again after the very next dream.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGenesisPolicy } from "../src/rsi/l5-gov/governance.ts";
import { MetaEvolution, MIN_META_CYCLES } from "../src/rsi/l6-meta/meta-evolution.ts";
import type { JournalEntry } from "../src/rsi/infra/journal.ts";

const episode = (aggregate: number, timestamp: number): JournalEntry[] => {
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

/** `n` dream episodes stamped from `from` on, each scoring `aggregate`. */
const episodes = (n: number, aggregate: number, from: number): JournalEntry[] =>
  Array.from({ length: n }, (_, i) => episode(aggregate, from + i)).flat();

/** A journal the test appends to, read the way L6 reads it (since a time). */
function harness() {
  const journal: JournalEntry[] = [];
  let now = 1_000;
  let seed = 5;
  const me = new MetaEvolution({
    dir: mkdtempSync(join(tmpdir(), "meta-proposal-")),
    now: () => now,
    readWindow: (since) => journal.filter((e) => e.timestamp >= since),
    seedSource: () => seed++,
    policy: () => defaultGenesisPolicy(), // fresh install: l6Evolve needs a person
  });
  const dream = (n: number, aggregate: number) => {
    journal.push(...episodes(n, aggregate, now));
    now += n + 1;
  };
  return { me, dream, at: () => now };
}

describe("L6 proposals answered in chat", () => {
  test("too little evidence: nothing to ask", () => {
    const { me, dream } = harness();
    dream(MIN_META_CYCLES - 1, 0.5);
    expect(me.propose()).toBeNull();
    expect(me.pendingProposal()).toBeNull();
  });

  test("a proposal changes nothing until approved, and approving applies exactly it", () => {
    const { me, dream } = harness();
    dream(MIN_META_CYCLES, 0.5);
    const before = me.current();
    const made = me.propose()!;
    expect(made.created).toBe(true);
    const p = made.proposal;
    expect(p.kind).toBe("change");
    expect(p.from).toBe(before[p.field]);
    expect(p.to).not.toBe(p.from);
    expect(me.current()).toEqual(before); // proposing is not changing
    expect(me.status().generation).toBe(0);

    // Asked again before an answer: the same card, not a new one.
    expect(me.propose()).toEqual({ proposal: p, created: false });

    const r = me.approve(p.id, "you, in chat");
    expect(r.ok).toBe(true);
    expect(me.current()[p.field]).toBe(p.to);
    expect(me.status().generation).toBe(1);
    expect(me.pendingProposal()).toBeNull();
    expect(me.history().at(-1)?.event).toBe("proposed");
  });

  test("an out-of-date card changes nothing", () => {
    const { me, dream } = harness();
    dream(MIN_META_CYCLES, 0.5);
    const p = me.propose()!.proposal;
    expect(me.approve("gen-0-999", "you, in chat")).toMatchObject({ ok: false, stale: true });
    expect(me.deny("gen-0-999", "you, in chat")).toMatchObject({ ok: false, stale: true });
    expect(me.pendingProposal()?.id).toBe(p.id);
    expect(me.status().generation).toBe(0);
  });

  test("a no drops the card and is not asked again until enough new dreams", () => {
    const { me, dream } = harness();
    dream(MIN_META_CYCLES, 0.5);
    const p = me.propose()!.proposal;
    expect(me.deny(p.id, "you, in chat").ok).toBe(true);
    expect(me.pendingProposal()).toBeNull();
    expect(me.status().generation).toBe(0);

    dream(1, 0.5);
    expect(me.propose()).toBeNull(); // the very next dream does not nag
    dream(MIN_META_CYCLES, 0.5);
    expect(me.propose()?.created).toBe(true);
  });

  test("a change that did not help comes back as an undo card", () => {
    const { me, dream } = harness();
    dream(MIN_META_CYCLES, 0.6);
    const change = me.propose()!.proposal;
    me.approve(change.id, "you, in chat");

    dream(MIN_META_CYCLES, 0.2); // worse under the new setting
    const undo = me.propose()!.proposal;
    expect(undo.kind).toBe("undo");
    expect(undo.settled).toBe("rejected");
    expect(undo.field).toBe(change.field);
    expect(undo.from).toBe(change.to);
    expect(undo.to).toBe(change.from);
    expect(undo.baselineScore).not.toBeNull();

    expect(me.approve(undo.id, "you, in chat").ok).toBe(true);
    expect(me.current()[change.field]).toBe(change.from);
  });

  test("a change that helped is said so on the next card", () => {
    const { me, dream } = harness();
    dream(MIN_META_CYCLES, 0.3);
    me.approve(me.propose()!.proposal.id, "you, in chat");
    dream(MIN_META_CYCLES, 0.9); // better under the new setting
    const next = me.propose()!.proposal;
    expect(next.kind).toBe("change");
    expect(next.settled).toBe("accepted");
    expect(next.baselineScore).not.toBeNull();
    expect(next.score).toBeGreaterThan(next.baselineScore!);
  });

  test("the card survives a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "meta-proposal-restart-"));
    const journal = episodes(MIN_META_CYCLES, 0.5, 1_000);
    const opts = { dir, now: () => 2_000, readWindow: () => journal, seedSource: () => 9, policy: () => defaultGenesisPolicy() };
    const p = new MetaEvolution(opts).propose()!.proposal;
    expect(existsSync(join(dir, "meta_proposal.json"))).toBe(true);
    expect(new MetaEvolution(opts).pendingProposal()).toEqual(p);
  });
});
