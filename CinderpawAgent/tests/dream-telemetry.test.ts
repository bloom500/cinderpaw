/**
 * Dream Cycle telemetry — best-effort JSONL episode log.
 *
 * The contract under test:
 *   1. Two records appended to a fresh tmp file produce a file with
 *      exactly two newline-separated lines, each parseable as JSON back
 *      into the original record (round-trip).
 *   2. Appending to a path inside a non-existent directory does NOT
 *      throw. Telemetry is a soft layer; the engine must survive a
 *      missing-dir situation silently.
 *
 * Real disk I/O on purpose — we want to exercise `appendFileSync` and
 * the missing-dir branch on the actual platform, not a mock.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDreamTelemetry,
  type DreamEpisodeRecord,
} from "../src/rsi/l1-config/dream-telemetry.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function freshTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cinderpaw-dream-telem-"));
  tmpDirs.push(d);
  return d;
}

function sampleRecord(overrides: Partial<DreamEpisodeRecord> = {}): DreamEpisodeRecord {
  return {
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    trigger: "idle",
    iterations: 17,
    tokens: 42_000,
    ratchets: 3,
    stopReason: "plateau",
    ...overrides,
  };
}

describe("appendDreamTelemetry — happy path", () => {
  test("two records → two newline-separated JSON lines that round-trip", () => {
    const dir = freshTmpDir();
    const path = join(dir, "dream.jsonl");
    const a = sampleRecord({ trigger: "idle", iterations: 5 });
    const b = sampleRecord({
      startedAt: 1_700_000_100_000,
      endedAt: 1_700_000_130_000,
      trigger: "error",
      iterations: 9,
      tokens: 12_345,
      ratchets: 1,
      stopReason: "iter_cap",
    });

    appendDreamTelemetry(path, a);
    appendDreamTelemetry(path, b);

    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n");
    // Exactly two lines: the file ends in a single trailing newline after
    // the second record, so split() gives ["...json...", "...json...", ""].
    // Two non-empty lines, plus the trailing empty.
    expect(lines.filter((l) => l.length > 0)).toHaveLength(2);

    const parsedA = JSON.parse(lines[0]!) as DreamEpisodeRecord;
    const parsedB = JSON.parse(lines[1]!) as DreamEpisodeRecord;
    expect(parsedA).toEqual(a);
    expect(parsedB).toEqual(b);
  });

  test("appending once creates the file if it didn't exist", () => {
    const dir = freshTmpDir();
    const path = join(dir, "fresh.jsonl");
    const rec = sampleRecord({ trigger: "manual", iterations: 1 });
    appendDreamTelemetry(path, rec);
    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw.trimEnd()) as DreamEpisodeRecord).toEqual(rec);
  });

  test("appending many records keeps them in order and one-per-line", () => {
    const dir = freshTmpDir();
    const path = join(dir, "many.jsonl");
    const records: DreamEpisodeRecord[] = [];
    for (let i = 0; i < 50; i++) {
      const r = sampleRecord({
        trigger: i % 2 === 0 ? "idle" : "error",
        iterations: i,
        tokens: i * 1000,
        startedAt: 1_700_000_000_000 + i * 1000,
        endedAt: 1_700_000_001_000 + i * 1000,
      });
      records.push(r);
      appendDreamTelemetry(path, r);
    }
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      expect(JSON.parse(lines[i]!) as DreamEpisodeRecord).toEqual(records[i]);
    }
  });
});

describe("appendDreamTelemetry — soft-failure contract", () => {
  test("appending to a path inside a non-existent directory does NOT throw", () => {
    const dir = freshTmpDir();
    // Note: the parent dir does NOT exist.
    const path = join(dir, "does-not-exist", "dream.jsonl");
    const rec = sampleRecord({ trigger: "idle" });
    // The whole point of this layer: a missing dir must not break the engine.
    expect(() => appendDreamTelemetry(path, rec)).not.toThrow();
  });

  test("appending to a path whose parent is a regular file does NOT throw", () => {
    const dir = freshTmpDir();
    // Treat a file as a directory — ENOTDIR. Must still be swallowed.
    const blocker = join(dir, "blocker");
    const path = join(blocker, "dream.jsonl");
    expect(() => appendDreamTelemetry(path, sampleRecord())).not.toThrow();
  });

  test("a failed write does not corrupt a subsequent successful write", () => {
    const dir = freshTmpDir();
    const goodPath = join(dir, "good.jsonl");
    // First call targets a bogus path; must not throw and must not leave
    // any state behind that breaks the next call.
    expect(() =>
      appendDreamTelemetry(join(dir, "missing", "x.jsonl"), sampleRecord()),
    ).not.toThrow();
    // Second call to the real path works normally.
    const rec = sampleRecord({ trigger: "manual", iterations: 1 });
    appendDreamTelemetry(goodPath, rec);
    const lines = readFileSync(goodPath, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!) as DreamEpisodeRecord).toEqual(rec);
  });
});
