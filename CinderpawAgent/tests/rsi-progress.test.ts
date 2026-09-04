/**
 * Improvement telemetry — the longitudinal series behind self_progress.
 * Writes real journal rows via appendJournal (so the chain fields are
 * valid) across two UTC days, then checks the aggregation and trend.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJournal, journalFilename, type JournalEntry } from "../src/rsi/infra/journal.ts";
import { improvementSeries } from "../src/rsi/infra/progress.ts";

const dir = mkdtempSync(join(tmpdir(), "cinderpaw-progress-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function entry(over: { aggregate?: number; action?: "accept" | "reject" | "halt" }): JournalEntry {
  const action = over.action ?? "accept";
  return {
    cycleId: `c-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    durationMin: 1,
    observed: [],
    hypothesized: [],
    experimented: { candidateId: "g1", change: "x", layer: "L1" },
    result:
      over.aggregate !== undefined
        ? {
            fitnessVector: {
              accuracy: over.aggregate, latency: 0.5, cost: 0.5,
              toolSuccess: 0.5, hallucination: 0.5, userSatisfaction: 0.5,
            },
            aggregate: over.aggregate,
            confidence: 0.9,
            tier0: "passed",
            tier1: "no_regression",
          }
        : null,
    decided:
      action === "accept"
        ? { action, reason: "r" }
        : action === "reject"
          ? { action, reason: "r", nextStep: "n" }
          : { action, reason: "r", stage: "observe" },
    budgetRemaining: { wallClockMin: 1, tokens: 1, cpuPct: 1, ramMb: 1 },
  } as JournalEntry;
}

test("aggregates per-day counts, means, and the rising trend", () => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  // Yesterday: two cycles, lower scores, one reject.
  appendJournal(join(dir, journalFilename(yesterday)), entry({ aggregate: 0.4 }));
  appendJournal(join(dir, journalFilename(yesterday)), entry({ aggregate: 0.5, action: "reject" }));
  // Today: one better cycle and one halt (no result).
  appendJournal(join(dir, journalFilename(now)), entry({ aggregate: 0.7 }));
  appendJournal(join(dir, journalFilename(now)), entry({ action: "halt" }));

  const s = improvementSeries(dir, 7, now);
  expect(s.days.length).toBe(7);
  expect(s.activeDays).toBe(2);
  expect(s.totalCycles).toBe(4);
  expect(s.totalAccepted).toBe(2);

  const yRow = s.days[s.days.length - 2]!;
  expect(yRow.cycles).toBe(2);
  expect(yRow.rejected).toBe(1);
  expect(yRow.meanAggregate).toBeCloseTo(0.45, 6);

  const tRow = s.days[s.days.length - 1]!;
  expect(tRow.halted).toBe(1);
  expect(tRow.meanAggregate).toBeCloseTo(0.7, 6);

  // Trend: 0.7 (today) - 0.45 (yesterday) = +0.25 → climbing.
  expect(s.aggregateTrend).toBeCloseTo(0.25, 6);
});

test("empty dir → flat zero series, null trend, never throws", () => {
  const empty = mkdtempSync(join(tmpdir(), "cinderpaw-progress-empty-"));
  try {
    const s = improvementSeries(empty, 3);
    expect(s.days.length).toBe(3);
    expect(s.totalCycles).toBe(0);
    expect(s.aggregateTrend).toBeNull();
    expect(s.days.every((d) => d.meanAggregate === null)).toBe(true);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
