/**
 * L0 — Journal tamper detection (B5 e2e smoke, assembled version).
 *
 * Env-gated: FERAL_E2E=1 bun test tests/l0-journal-tamper.e2e.test.ts
 *
 * Two contracts pinned here (the granular tests live in
 * `rsi-journal-chain.test.ts`; this file is the assembled end-to-end
 * view a senior reviewer can read in 60 seconds):
 *   1. `verifyJournal` flags the first byte-tampered row in a chained
 *      file and reports its 1-based row number.
 *   2. `defaultReadWindow` EXCLUDES a day-file that fails verification
 *      from the read window AND surfaces the failure (not a silent drop).
 *
 * Failure-path: we deliberately tamper the chained row in-memory and
 * confirm both behaviors fire. Drop the tamper and confirm the file is
 * accepted again.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GENESIS } from "../src/rsi/hash-chain.ts";
import {
  appendJournal,
  journalFilename,
  type JournalEntry,
} from "../src/rsi/journal.ts";
import { defaultReadWindow } from "../src/rsi/meta-evolution.ts";

const ENABLED = process.env.FERAL_E2E === "1";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function entry(cycleId: string, ts: number): JournalEntry {
  return {
    cycleId,
    timestamp: ts,
    durationMin: 5,
    observed: ["obs"],
    hypothesized: ["hyp"],
    experimented: null,
    result: null,
    decided: { action: "halt", reason: "test", stage: "observe" },
    budgetRemaining: { wallClockMin: 1, tokens: 1, cpuPct: 1, ramMb: 1, diskMb: 1 },
  };
}

describe("L0 — journal tamper detection (FERAL_E2E)", () => {
  it.skipIf(!ENABLED)(
    "a byte-tampered row is flagged by verifyJournal AND excluded by defaultReadWindow",
    async () => {
      const dir = freshDir("feral-e2e-jt-");
      const now = Date.UTC(2026, 6, 9, 12, 0, 0);

      // Build a day-file with a few chained entries, then tamper the middle row.
      const path = join(dir, journalFilename(new Date(now)));
      appendJournal(path, entry("c-1", now));
      appendJournal(path, entry("c-2", now + 1));
      appendJournal(path, entry("c-3", now + 2));
      const linesBefore = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
      const tampered = JSON.parse(linesBefore[1]!) as JournalEntry;
      tampered.durationMin = 999; // tamper
      writeFileSync(
        path,
        [linesBefore[0], JSON.stringify(tampered), linesBefore[2]].join("\n") + "\n",
        "utf8",
      );

      // ── Guard 1: verifyJournal flags the row
      // (read the chain fresh from disk via the public ts entrypoint:
      //  we re-parse by reading the file via appendJournal's loader,
      //  but the canonical entry is `verifyJournal` which itself does
      //  the parse; we exercise the same shape through the import.)
      const { verifyJournal } = await import("../src/rsi/journal.ts");
      const res = verifyJournal(path);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.badRow).toBe(2);

      // ── Guard 2: defaultReadWindow EXCLUDES the day-file and surfaces the failure
      const surfaced: string[] = [];
      const window = defaultReadWindow(0, now, {
        dir,
        onBadFile: (path, reason) => surfaced.push(`${path}: ${reason}`),
      });
      // The tampered file produces zero accepted entries. The other
      // day-files in the dir are absent, so the window is empty.
      expect(window).toHaveLength(0);
      expect(surfaced).toHaveLength(1);
      expect(surfaced[0]).toContain(journalFilename(new Date(now)));

      // ── Negative control: restore the chain, the same window
      //    accepts the file again (no false-positive in either guard).
      writeFileSync(path, linesBefore.join("\n") + "\n", "utf8");
      const resClean = verifyJournal(path);
      expect(resClean.ok).toBe(true);
      const windowClean = defaultReadWindow(0, now, {
        dir,
        onBadFile: () => {},
      });
      expect(windowClean.map((e) => e.cycleId)).toEqual(["c-1", "c-2", "c-3"]);
    },
  );

  it.skipIf(!ENABLED)(
    "an empty (GENESIS-only) chain verifies cleanly",
    async () => {
      const dir = freshDir("feral-e2e-jt-empty-");
      const now = Date.UTC(2026, 6, 9, 12, 0, 0);
      const path = join(dir, journalFilename(new Date(now)));
      appendJournal(path, entry("c-only", now));
      const { verifyJournal } = await import("../src/rsi/journal.ts");
      const res = verifyJournal(path);
      expect(res.ok).toBe(true);
      expect(res.entries).toBe(1);
      // Sanity: the anchor must be the GENESIS sentinel, not empty.
      const row = JSON.parse(
        readFileSync(path, "utf8").split("\n")[0]!,
      ) as JournalEntry & { prevHash: string };
      expect(row.prevHash).toBe(GENESIS);
    },
  );
});
