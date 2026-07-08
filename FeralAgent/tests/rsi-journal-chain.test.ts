/**
 * Journal hash chain — A2 (L5 spec §2.4, G-INV-4).
 *
 * Contract under test:
 *   1. `appendJournal` chains rows: sha256(prevHash || 0x02 || canonical(row)),
 *      genesis "GENESIS", chain per-day-file.
 *   2. `verifyJournal` walks the chain: detects a mutated middle row, a
 *      deleted row, and a malformed row, naming the first bad row.
 *   3. Back-compat: rows without `hash` (pre-L5) verify as legacy and are
 *      accepted until the first chained row appears; after that, unchained
 *      rows fail.
 *   4. Appending to a legacy file starts the chain at GENESIS.
 *   5. L6 `defaultReadWindow` skips files that fail verification and
 *      surfaces the failure (spec §9 row 4, skip part).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENESIS, canonicalJson, chainHash } from "../src/rsi/hash-chain.ts";
import {
  appendJournal,
  journalFilename,
  readJournal,
  verifyJournal,
  type JournalEntry,
} from "../src/rsi/journal.ts";
import { defaultReadWindow } from "../src/rsi/meta-evolution.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "feral-jchain-"));
  tmpDirs.push(d);
  return d;
}

function entry(cycleId: string, timestamp = 1_752_000_000_000): JournalEntry {
  return {
    cycleId,
    timestamp,
    durationMin: 5,
    observed: ["obs"],
    hypothesized: ["hyp"],
    experimented: null,
    result: null,
    decided: { action: "halt", reason: "test", stage: "observe" },
    budgetRemaining: { wallClockMin: 1, tokens: 1, cpuPct: 1, ramMb: 1, diskMb: 1 },
  };
}

/** A pre-L5 row: no prevHash/hash. */
function legacyLine(cycleId: string): string {
  return JSON.stringify(entry(cycleId)) + "\n";
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
}

describe("canonicalJson / chainHash", () => {
  test("canonicalJson is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [{ y: 2, x: 3 }] })).toBe(canonicalJson({ a: [{ x: 3, y: 2 }], b: 1 }));
  });

  test("chainHash differs when prev or row differs", () => {
    const row = { a: 1 };
    expect(chainHash(GENESIS, row)).not.toBe(chainHash("other", row));
    expect(chainHash(GENESIS, row)).not.toBe(chainHash(GENESIS, { a: 2 }));
  });
});

describe("appendJournal — chained writes", () => {
  test("first row anchors at GENESIS and carries its own hash", () => {
    const path = join(freshTmpDir(), "j.jsonl");
    appendJournal(path, entry("c-1"));
    const row = JSON.parse(lines(path)[0]!) as JournalEntry;
    expect(row.prevHash).toBe(GENESIS);
    expect(typeof row.hash).toBe("string");
    const { prevHash: _p, hash, ...body } = row;
    expect(chainHash(GENESIS, body)).toBe(hash);
  });

  test("second row links to the first row's hash", () => {
    const path = join(freshTmpDir(), "j.jsonl");
    appendJournal(path, entry("c-1"));
    appendJournal(path, entry("c-2", 1_752_000_060_000));
    const [r1, r2] = lines(path).map((l) => JSON.parse(l) as JournalEntry);
    expect(r2!.prevHash).toBe(r1!.hash);
  });

  test("appending to a legacy (unchained) file starts the chain at GENESIS", () => {
    const path = join(freshTmpDir(), "j.jsonl");
    writeFileSync(path, legacyLine("old-1") + legacyLine("old-2"), "utf8");
    appendJournal(path, entry("c-new"));
    const all = lines(path);
    const row = JSON.parse(all[2]!) as JournalEntry;
    expect(row.prevHash).toBe(GENESIS);
  });

  test("caller-supplied prevHash/hash are ignored (chain is writer-owned)", () => {
    const path = join(freshTmpDir(), "j.jsonl");
    appendJournal(path, { ...entry("c-1"), prevHash: "forged", hash: "forged" });
    const row = JSON.parse(lines(path)[0]!) as JournalEntry;
    expect(row.prevHash).toBe(GENESIS);
    expect(row.hash).not.toBe("forged");
    expect(verifyJournal(path).ok).toBe(true);
  });
});

describe("verifyJournal", () => {
  test("missing file verifies ok with zero entries", () => {
    expect(verifyJournal(join(freshTmpDir(), "absent.jsonl"))).toEqual({ ok: true, entries: 0, legacy: 0 });
  });

  test("a fully-chained file verifies ok", () => {
    const path = join(freshTmpDir(), "j.jsonl");
    for (let i = 0; i < 5; i++) appendJournal(path, entry(`c-${i}`, 1_752_000_000_000 + i));
    expect(verifyJournal(path)).toEqual({ ok: true, entries: 5, legacy: 0 });
  });

  test("a mutated middle row is detected at its row number", () => {
    const path = join(freshTmpDir(), "j.jsonl");
    for (let i = 0; i < 3; i++) appendJournal(path, entry(`c-${i}`, 1_752_000_000_000 + i));
    const all = lines(path);
    const tampered = JSON.parse(all[1]!) as JournalEntry;
    tampered.durationMin = 999; // the tamper
    writeFileSync(path, [all[0], JSON.stringify(tampered), all[2]].join("\n") + "\n", "utf8");
    const res = verifyJournal(path);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.badRow).toBe(2);
  });

  test("a deleted row breaks the linkage at the following row", () => {
    const path = join(freshTmpDir(), "j.jsonl");
    for (let i = 0; i < 3; i++) appendJournal(path, entry(`c-${i}`, 1_752_000_000_000 + i));
    const all = lines(path);
    writeFileSync(path, [all[0], all[2]].join("\n") + "\n", "utf8");
    const res = verifyJournal(path);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.badRow).toBe(2);
  });

  test("malformed JSON is a verification failure (not a throw)", () => {
    const path = join(freshTmpDir(), "j.jsonl");
    appendJournal(path, entry("c-1"));
    appendFileSync(path, "{broken\n", "utf8");
    const res = verifyJournal(path);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.badRow).toBe(2);
  });

  test("legacy-only file verifies ok as legacy", () => {
    const path = join(freshTmpDir(), "j.jsonl");
    writeFileSync(path, legacyLine("old-1") + legacyLine("old-2"), "utf8");
    expect(verifyJournal(path)).toEqual({ ok: true, entries: 0, legacy: 2 });
  });

  test("legacy rows followed by chained rows verify ok", () => {
    const path = join(freshTmpDir(), "j.jsonl");
    writeFileSync(path, legacyLine("old-1"), "utf8");
    appendJournal(path, entry("c-1"));
    appendJournal(path, entry("c-2", 1_752_000_000_001));
    expect(verifyJournal(path)).toEqual({ ok: true, entries: 2, legacy: 1 });
  });

  test("an unchained row AFTER the chain started fails", () => {
    const path = join(freshTmpDir(), "j.jsonl");
    appendJournal(path, entry("c-1"));
    appendFileSync(path, legacyLine("smuggled"), "utf8");
    const res = verifyJournal(path);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.badRow).toBe(2);
  });

  test("readJournal still round-trips chained entries (type guard tolerant)", () => {
    const path = join(freshTmpDir(), "j.jsonl");
    appendJournal(path, entry("c-1"));
    const entries = readJournal(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.cycleId).toBe("c-1");
  });
});

describe("defaultReadWindow — G-INV-4 skip", () => {
  test("a day-file failing verification is excluded and the failure surfaced", () => {
    const dir = freshTmpDir();
    mkdirSync(dir, { recursive: true });
    const now = Date.UTC(2026, 6, 8, 12, 0, 0);
    // Yesterday: valid chained file.
    const goodPath = join(dir, journalFilename(new Date(now - 86_400_000)));
    appendJournal(goodPath, entry("c-good", now - 86_400_000));
    // Today: chained then tampered.
    const badPath = join(dir, journalFilename(new Date(now)));
    appendJournal(badPath, entry("c-bad-1", now));
    appendJournal(badPath, entry("c-bad-2", now + 1));
    const all = readFileSync(badPath, "utf8").split("\n").filter((l) => l.trim());
    const t = JSON.parse(all[0]!) as JournalEntry;
    t.durationMin = 999;
    writeFileSync(badPath, [JSON.stringify(t), all[1]].join("\n") + "\n", "utf8");

    const surfaced: string[] = [];
    const window = defaultReadWindow(0, now, {
      dir,
      onBadFile: (path, reason) => surfaced.push(`${path}: ${reason}`),
    });
    expect(window.map((e) => e.cycleId)).toEqual(["c-good"]);
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]).toContain(journalFilename(new Date(now)));
  });

  test("legacy files still flow into the window (back-compat)", () => {
    const dir = freshTmpDir();
    const now = Date.UTC(2026, 6, 8, 12, 0, 0);
    writeFileSync(join(dir, journalFilename(new Date(now))), legacyLine("old-1"), "utf8");
    const window = defaultReadWindow(0, now, { dir });
    expect(window.map((e) => e.cycleId)).toEqual(["old-1"]);
  });
});
