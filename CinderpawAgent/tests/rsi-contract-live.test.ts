/**
 * Contract FSM threaded into the live ratchet path (Slice 1 of
 * `docs/superpowers/specs/2026-07-01-contract-fsm-live-design.md`).
 *
 * The promotion behaviour itself is pinned by the existing ratchet tests
 * (rsi-ratchet-handler / rsi-ratchet-with-confidence) — what's NEW here is
 * the one per-candidate Journal row per terminal (I3/I4):
 *   - promoted candidate  → `accept` row with a real result (fitnessVector,
 *     aggregate, tier0 passed);
 *   - tier-0 breach       → `reject` row, tier0 failed, no promotion;
 *   - confidence-gate no  → `reject` row with the gate's reason, no promotion.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, type RsiEvent } from "../src/rsi/infra/event-bus.ts";
import { RatchetHandler } from "../src/rsi/l1-config/ratchet-handler.ts";
import type { EvalOutcome } from "../src/rsi/infra/eval-worker.ts";
import type { JournalEntry } from "../src/rsi/infra/journal.ts";
import type { GateDecision } from "../src/rsi/infra/confidence.ts";

const JOURNAL = join(tmpdir(), `rsi-contract-live-test-${process.pid}.jsonl`);
const journalPath = () => JOURNAL;

afterEach(() => {
  rmSync(JOURNAL, { force: true });
});

function readRows(): JournalEntry[] {
  if (!existsSync(JOURNAL)) return [];
  return readFileSync(JOURNAL, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as JournalEntry);
}

function outcome(taskId: string, success: boolean, tier = 1): EvalOutcome {
  return { taskId, tier, success, latencyMs: 1, tokens: 1, errored: false };
}

const REJECT: GateDecision = {
  accept: false,
  reason: "not significant",
  bootstrap: { mean: 0, ciLower: 0, ciUpper: 0, pValue: 0.4, effectSize: 0.01 },
};

describe("Contract FSM in the live ratchet path — per-candidate Journal rows", () => {
  test("a decline names the two scores the ratchet actually compared", async () => {
    // The old message read `ratchet declined: previous best 0 >= 50`, built
    // from the sidecar's own score and the prior best. It is false as written
    // — 0 is not >= 50 — and it names neither side of the real comparison,
    // which is the candidate's COMMITTED score against main's. Journals full
    // of that sentence are unreadable, and one of them is the whole artifact
    // of an evolution run.
    const bus = new EventBus();
    new RatchetHandler(bus, {
      commitGenome: async () => ({ commitHash: "a".repeat(40) }),
      ratchetAttempt: async () => ({
        advanced: false,
        previousBest: 62,
        candidateScore: 50,
        hadPrior: true,
      }),
      journalPath,
    });

    await bus.emit({
      type: "EvalComplete",
      genomeId: "g1",
      score: 73,
      outcomes: [outcome("t0", true, 0)],
      errored: false,
    });

    const reason = readRows()[0]!.decided.reason ?? "";
    expect(reason).toContain("candidate scored 50");
    expect(reason).toContain("main already scores 62");
    // 73 is the sidecar's score for the same candidate. It is deliberately
    // NOT in the message: the ratchet never saw it, and printing it is how
    // the old message misled.
    expect(reason).not.toContain("73");
    expect(reason).not.toMatch(/>=/);
  });

  test("a promoted candidate writes an accept row with a real result", async () => {
    const bus = new EventBus();
    const advanced: RsiEvent[] = [];
    bus.on("RatchetAdvanced", async (e) => advanced.push(e));

    new RatchetHandler(bus, {
      commitGenome: async () => ({ commitHash: "a".repeat(40) }),
      ratchetAttempt: async () => ({ advanced: true, previousBest: 40 }),
      cycleId: () => "c-test-cycle",
      journalPath,
    });

    await bus.emit({
      type: "EvalComplete",
      genomeId: "g1",
      score: 73,
      outcomes: [outcome("t0", true, 0), outcome("t1", true)],
      errored: false,
    });

    expect(advanced.length).toBe(1);
    const rows = readRows();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.cycleId).toBe("c-test-cycle");
    expect(row.experimented?.candidateId).toBe("g1");
    expect(row.experimented?.layer).toBe("L1");
    expect(row.decided.action).toBe("accept");
    // The fields the episode summary leaves null are REAL here.
    expect(row.result).not.toBeNull();
    expect(row.result!.tier0).toBe("passed");
    expect(row.result!.fitnessVector.accuracy).toBeCloseTo(0.73);
    expect(row.result!.aggregate).toBeCloseTo(0.73);
  });

  test("a tier-0 breach writes a reject row and does not promote", async () => {
    const bus = new EventBus();
    const advanced: RsiEvent[] = [];
    const failed: RsiEvent[] = [];
    bus.on("RatchetAdvanced", async (e) => advanced.push(e));
    bus.on("ConfidenceFailed", async (e) => failed.push(e));

    let attempts = 0;
    new RatchetHandler(bus, {
      commitGenome: async () => ({ commitHash: "b".repeat(40) }),
      ratchetAttempt: async () => {
        attempts += 1;
        return { advanced: true, previousBest: 0 };
      },
      journalPath,
    });

    await bus.emit({
      type: "EvalComplete",
      genomeId: "broken",
      score: 99,
      outcomes: [outcome("t0", false, 0), outcome("t1", true)],
      errored: false,
    });

    expect(attempts).toBe(0);
    expect(advanced.length).toBe(0);
    expect(failed.length).toBe(1);
    const rows = readRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.decided.action).toBe("reject");
    expect(rows[0]!.decided.reason).toContain("Tier 0 floor breached");
    // The pipeline halted at `tests` — before benchmark — so result is null.
    expect(rows[0]!.result).toBeNull();
  });

  test("a confidence-gate rejection writes a reject row with the gate's reason", async () => {
    const bus = new EventBus();
    const advanced: RsiEvent[] = [];
    bus.on("RatchetAdvanced", async (e) => advanced.push(e));

    let commits = 0;
    let attempts = 0;
    new RatchetHandler(bus, {
      commitGenome: async () => {
        commits += 1;
        return { commitHash: "c".repeat(40) };
      },
      ratchetAttempt: async () => {
        attempts += 1;
        return { advanced: true, previousBest: 0 };
      },
      evaluateGate: () => REJECT,
      journalPath,
    });

    const tasks = [outcome("t0", true), outcome("t1", true), outcome("t2", false)];
    // First candidate bootstraps the baseline (gate bypassed) → accept row.
    await bus.emit({ type: "EvalComplete", genomeId: "champ", score: 60, outcomes: tasks, errored: false });
    // Second candidate hits the REJECT gate → reject row, no ratchetAttempt.
    await bus.emit({ type: "EvalComplete", genomeId: "noisy", score: 61, outcomes: tasks, errored: false });

    expect(commits).toBe(2);
    expect(attempts).toBe(1);
    expect(advanced.length).toBe(1);
    const rows = readRows();
    expect(rows.length).toBe(2);
    expect(rows[0]!.decided.action).toBe("accept");
    expect(rows[1]!.decided.action).toBe("reject");
    expect(rows[1]!.decided.reason).toBe("not significant");
    // The gate fired AFTER benchmark, so the reject row still carries the
    // candidate's measured fitness — the transparency the spec wants.
    expect(rows[1]!.result).not.toBeNull();
  });
});

describe("Slice 2 — real userSatisfaction in the benchmark leaf (§2.10, goodhart-gated)", () => {
  test("successful tool-call audit rows give userSatisfaction > 0.5; the ratchet still sees the raw score", async () => {
    const bus = new EventBus();
    const scoresSeen: number[] = [];

    new RatchetHandler(bus, {
      commitGenome: async () => ({ commitHash: "d".repeat(40) }),
      ratchetAttempt: async (_hash, score) => {
        scoresSeen.push(score);
        return { advanced: true, previousBest: 0 };
      },
      journalPath,
      // Five successful tool calls in the last hour — all-positive signal.
      readRecentAudit: () =>
        Array.from({ length: 5 }, (_, i) => ({
          timestamp: Date.now() - i * 60_000,
          actionType: "tool_call",
          toolName: `tool${i}`,
          result: "success",
        })),
    });

    await bus.emit({
      type: "EvalComplete",
      genomeId: "g-sat",
      score: 73,
      outcomes: [outcome("t0", true, 0), outcome("t1", true)],
      errored: false,
    });

    const rows = readRows();
    expect(rows.length).toBe(1);
    const result = rows[0]!.result!;
    // Real signal, all positive → satisfied, not neutral.
    expect(result.fitnessVector.userSatisfaction).toBeGreaterThan(0.5);
    // hallucination stays the unmeasured neutral.
    expect(result.fitnessVector.hallucination).toBe(0.5);
    // GUARDRAIL §6.1: promotion input unchanged — raw score to the ratchet,
    // score-proxy aggregate in the journal, satisfaction colours neither.
    expect(scoresSeen).toEqual([73]);
    expect(result.aggregate).toBeCloseTo(0.73);
  });

  test("tool errors push userSatisfaction below 0.5; without a reader it stays neutral", async () => {
    const emitTo = async (handlerBus: EventBus) =>
      handlerBus.emit({
        type: "EvalComplete",
        genomeId: "g-x",
        score: 50,
        outcomes: [outcome("t0", true)],
        errored: false,
      });

    // All-error audit → dissatisfied.
    const errBus = new EventBus();
    new RatchetHandler(errBus, {
      commitGenome: async () => ({ commitHash: "e".repeat(40) }),
      ratchetAttempt: async () => ({ advanced: true, previousBest: 0 }),
      journalPath,
      readRecentAudit: () => [
        { timestamp: Date.now(), actionType: "tool_call", result: "error" },
        { timestamp: Date.now(), actionType: "tool_call", result: "error" },
      ],
    });
    await emitTo(errBus);
    expect(readRows()[0]!.result!.fitnessVector.userSatisfaction).toBeLessThan(0.5);
    rmSync(JOURNAL, { force: true });

    // No reader → Slice-1 behaviour: neutral 0.5.
    const plainBus = new EventBus();
    new RatchetHandler(plainBus, {
      commitGenome: async () => ({ commitHash: "e".repeat(40) }),
      ratchetAttempt: async () => ({ advanced: true, previousBest: 0 }),
      journalPath,
    });
    await emitTo(plainBus);
    expect(readRows()[0]!.result!.fitnessVector.userSatisfaction).toBe(0.5);
  });
});
