/**
 * Evolution Journal — best-effort JSONL cycle log.
 *
 * Contract under test (mirrors `dream-telemetry.test.ts`):
 *   1. Appended entries round-trip: two records → two newline-separated
 *      JSON lines, each parseable back into the original.
 *   2. Path with a missing parent dir does NOT throw (best-effort).
 *   3. Path whose parent is a regular file does NOT throw.
 *   4. A failed write does not corrupt a subsequent successful write.
 *   5. readJournal returns [] for a missing file.
 *   6. readJournal parses valid entries and skips blank lines.
 *   7. readJournal THROWS on malformed JSON — a corrupt row is a signal.
 *   8. journalFilename + defaultJournalPath produce stable, predictable
 *      filenames (UTC components, padded).
 *
 * Real disk I/O on purpose — we want to exercise `appendFileSync` and
 * the missing-dir / ENOTDIR branches on the actual platform, not a mock.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  appendJournal,
  defaultJournalDir,
  defaultJournalPath,
  journalFilename,
  readJournal,
  type BudgetRemaining,
  type FitnessVector,
  type JournalEntry,
} from "../src/rsi/journal.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function freshTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "feral-journal-"));
  tmpDirs.push(d);
  return d;
}

const baseBudget: BudgetRemaining = {
  wallClockMin: 27,
  tokens: 18_000,
  cpuPct: 12,
  ramMb: 800,
  diskMb: 4,
};

const baseFitness: FitnessVector = {
  accuracy: 0.62,
  latency: 0.18,
  cost: 0.21,
  toolSuccess: 0.74,
  hallucination: 0.05,
  userSatisfaction: 0.81,
};

function sampleEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    cycleId: "c-2026-07-14-001",
    timestamp: 1_752_000_000_000,
    durationMin: 27,
    observed: ["Tool X failed 14% of the time on coding tasks"],
    hypothesized: ["Planner depth = 2 is too low for multi-step tool chains"],
    experimented: {
      candidateId: "cfg-2026-07-14-c-014",
      change: "decompositionDepth: 2 → 4",
      layer: "L1",
    },
    result: {
      fitnessVector: baseFitness,
      aggregate: 0.0034,
      confidence: 0.41,
      tier0: "passed",
      tier1: "no_regression",
    },
    decided: {
      action: "reject",
      reason: "confidence below gate; Δ within noise",
      nextStep: "Increase sample size; rerun on 200-task subset",
    },
    budgetRemaining: baseBudget,
    ...overrides,
  };
}

describe("appendJournal — happy path", () => {
  test("two records → two newline-separated JSON lines that round-trip", () => {
    const dir = freshTmpDir();
    const path = join(dir, "journal.jsonl");
    const a = sampleEntry({ cycleId: "c-1" });
    const b = sampleEntry({
      cycleId: "c-2",
      timestamp: 1_752_000_060_000,
      durationMin: 12,
      observed: [],
      hypothesized: [],
      experimented: null,
      result: null,
      decided: { action: "halt", reason: "budget exhausted", stage: "evaluate" },
      budgetRemaining: { ...baseBudget, wallClockMin: 0 },
    });

    appendJournal(path, a);
    appendJournal(path, b);

    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n");
    // Exactly two non-empty lines + trailing empty.
    expect(lines.filter((l) => l.length > 0)).toHaveLength(2);

    const parsedA = JSON.parse(lines[0]!) as JournalEntry;
    const parsedB = JSON.parse(lines[1]!) as JournalEntry;
    expect(parsedA).toEqual(a);
    expect(parsedB).toEqual(b);
  });

  test("appending once creates the file if it did not exist", () => {
    const dir = freshTmpDir();
    const path = join(dir, "fresh.jsonl");
    const entry = sampleEntry({ cycleId: "c-fresh" });

    appendJournal(path, entry);

    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw.trimEnd()) as JournalEntry).toEqual(entry);
  });

  test("appending many entries keeps them in order and one-per-line", () => {
    const dir = freshTmpDir();
    const path = join(dir, "many.jsonl");
    const entries: JournalEntry[] = [];
    for (let i = 0; i < 30; i++) {
      const e = sampleEntry({
        cycleId: `c-${i}`,
        timestamp: 1_752_000_000_000 + i * 1000,
        durationMin: i,
      });
      entries.push(e);
      appendJournal(path, e);
    }
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(30);
    for (let i = 0; i < 30; i++) {
      expect(JSON.parse(lines[i]!) as JournalEntry).toEqual(entries[i]);
    }
  });
});

describe("appendJournal — soft-failure contract", () => {
  test("appending to a path inside a non-existent directory does NOT throw", () => {
    const dir = freshTmpDir();
    const path = join(dir, "does-not-exist", "journal.jsonl");
    // Parent dir does NOT exist; mkdirSync({recursive:true}) makes it.
    // The "soft" branch in appendJournal covers a mkdirSync failure.
    // Verify the happy path: dir is created, entry is written.
    expect(() => appendJournal(path, sampleEntry())).not.toThrow();
    const raw = readFileSync(path, "utf8");
    expect(raw.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
  });

  test("appending to a path whose parent is a regular file does NOT throw", () => {
    const dir = freshTmpDir();
    const blocker = join(dir, "blocker");
    const path = join(blocker, "journal.jsonl");
    // Create a regular file at the position the journal would expect a
    // directory — mkdirSync will fail with ENOTDIR. The whole point of
    // the soft-failure contract: the engine must survive.
    writeFileSync(blocker, "not a dir", "utf8");
    expect(() => appendJournal(path, sampleEntry())).not.toThrow();
  });

  test("a failed write does not corrupt a subsequent successful write", () => {
    const dir = freshTmpDir();
    const goodPath = join(dir, "good.jsonl");
    // First call targets a path whose parent is a regular file → soft fail.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a dir", "utf8");
    expect(() =>
      appendJournal(join(blocker, "x.jsonl"), sampleEntry({ cycleId: "c-bad" })),
    ).not.toThrow();
    // Second call to the real path works normally.
    const entry = sampleEntry({ cycleId: "c-good" });
    appendJournal(goodPath, entry);
    const lines = readFileSync(goodPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!) as JournalEntry).toEqual(entry);
  });
});

describe("readJournal", () => {
  test("returns [] for a missing file (no throw)", () => {
    const dir = freshTmpDir();
    const path = join(dir, "absent.jsonl");
    expect(readJournal(path)).toEqual([]);
  });

  test("returns [] for an empty file", () => {
    const dir = freshTmpDir();
    const path = join(dir, "empty.jsonl");
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(path, "", "utf8");
    expect(readJournal(path)).toEqual([]);
  });

  test("skips blank lines between entries", () => {
    const dir = freshTmpDir();
    const path = join(dir, "blanks.jsonl");
    const a = sampleEntry({ cycleId: "c-a" });
    const b = sampleEntry({ cycleId: "c-b" });
    appendJournal(path, a);
    // Manually inject blank lines.
    appendFileSync(path, "\n\n", "utf8");
    appendJournal(path, b);
    const entries = readJournal(path);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.cycleId).toBe("c-a");
    expect(entries[1]!.cycleId).toBe("c-b");
  });

  test("throws on malformed JSON (corrupt row is a signal, not silent loss)", () => {
    const dir = freshTmpDir();
    const path = join(dir, "corrupt.jsonl");
    const a = sampleEntry({ cycleId: "c-a" });
    appendJournal(path, a);
    appendFileSync(path, "{not valid json\n", "utf8");
    expect(() => readJournal(path)).toThrow();
  });

  test("skips entries that fail the type guard (stale schema, missing fields)", () => {
    const dir = freshTmpDir();
    const path = join(dir, "mixed.jsonl");
    const a = sampleEntry({ cycleId: "c-good" });
    appendJournal(path, a);
    // Valid JSON but missing required fields — type guard must reject.
    appendFileSync(path, JSON.stringify({ cycleId: "x" }) + "\n", "utf8");
    // And a non-object value — type guard must reject.
    appendFileSync(path, JSON.stringify(42) + "\n", "utf8");
    const entries = readJournal(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.cycleId).toBe("c-good");
  });
});

describe("path helpers", () => {
  test("journalFilename uses UTC components with zero-padded month and day", () => {
    // 2026-01-05 UTC — month and day must be two digits.
    const date = new Date(Date.UTC(2026, 0, 5, 23, 59, 59));
    expect(journalFilename(date)).toBe("journal-2026-01-05.jsonl");
    // 2026-12-31 UTC.
    const date2 = new Date(Date.UTC(2026, 11, 31, 0, 0, 1));
    expect(journalFilename(date2)).toBe("journal-2026-12-31.jsonl");
  });

  test("defaultJournalPath combines defaultJournalDir + journalFilename", () => {
    const date = new Date(Date.UTC(2026, 6, 14, 12, 0, 0));
    const path = defaultJournalPath(date);
    expect(path).toBe(join(defaultJournalDir(), "journal-2026-07-14.jsonl"));
    expect(path.endsWith(`journal${sep}journal-2026-07-14.jsonl`)).toBe(true);
  });

  test("defaultJournalDir sits under ~/.feral/rsi/journal/", () => {
    expect(defaultJournalDir().endsWith(join(".feral", "rsi", "journal"))).toBe(true);
  });
});

describe("JournalEntry discriminated decisions", () => {
  test("accept decision has a reason", () => {
    const entry = sampleEntry({
      decided: { action: "accept", reason: "Δ=+0.018, p=0.01, d=0.34" },
    });
    expect(entry.decided.action).toBe("accept");
    if (entry.decided.action === "accept") {
      expect(entry.decided.reason).toMatch(/Δ=/);
    }
  });

  test("reject decision has a reason and a nextStep", () => {
    const entry = sampleEntry({
      decided: {
        action: "reject",
        reason: "confidence below gate",
        nextStep: "re-run with more samples",
      },
    });
    expect(entry.decided.action).toBe("reject");
    if (entry.decided.action === "reject") {
      expect(entry.decided.nextStep).toBe("re-run with more samples");
    }
  });

  test("halt decision has a reason and a stage", () => {
    const entry = sampleEntry({
      decided: { action: "halt", reason: "budget exhausted", stage: "evaluate" },
    });
    expect(entry.decided.action).toBe("halt");
    if (entry.decided.action === "halt") {
      expect(entry.decided.stage).toBe("evaluate");
    }
  });

  test("halt cycles carry null for experimented and result", () => {
    const entry = sampleEntry({
      experimented: null,
      result: null,
      decided: { action: "halt", reason: "Tier 0 failed", stage: "mutate" },
    });
    appendJournal(join(freshTmpDir(), "halt.jsonl"), entry);
    expect(entry.experimented).toBeNull();
    expect(entry.result).toBeNull();
  });
});