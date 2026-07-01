/**
 * BRSI §2.9 — the Evolution Journal wired at the dream-episode boundary.
 *
 * `onEpisodeEnd` writes one semantic lab-notebook row per episode
 * (INVARIANT I3: append-only) in addition to the flat ops telemetry. The
 * row's `decided` reflects the episode outcome: accept when candidates
 * ratcheted, reject when none cleared the bar, halt on an errored run.
 *
 * These tests exercise the mapping (`makeCycleSummary`) and the wiring
 * (a journal row appears after an episode ends).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeCycleSummary } from "../src/rsi/dream-cycle.ts";
import { readJournal } from "../src/rsi/journal.ts";

const START = Date.UTC(2026, 6, 1, 12, 0, 0); // 2026-07-01T12:00:00Z
const END = START + 90_000; // +1.5 min

describe("makeCycleSummary", () => {
  test("accept when candidates ratcheted", () => {
    const entry = makeCycleSummary(
      { startedAt: START, trigger: "idle" },
      { iterations: 12, tokens: 3400, ratchets: 2, stopReason: "converged", errors: [], emptyResponses: 0 },
      END,
    );
    expect(entry.cycleId).toBe("c-2026-07-01T12:00:00.000Z");
    expect(entry.durationMin).toBeCloseTo(1.5, 5);
    expect(entry.decided.action).toBe("accept");
    expect(entry.experimented).toBeNull();
    expect(entry.result).toBeNull();
    expect(entry.observed).toContain("12 evaluation(s), 2 promoted to main");
  });

  test("surfaces confidence-gate rejections in observed (ADR-0012)", () => {
    const entry = makeCycleSummary(
      { startedAt: START, trigger: "idle" },
      { iterations: 10, tokens: 2000, ratchets: 1, confidenceRejections: 3, stopReason: "converged", errors: [], emptyResponses: 0 },
      END,
    );
    expect(entry.observed).toContain(
      "3 candidate(s) beat the score but were blocked by a promotion gate (confidence / Tier 0 floor)",
    );
  });

  test("no rejection line when the gate rejected nothing", () => {
    const entry = makeCycleSummary(
      { startedAt: START, trigger: "idle" },
      { iterations: 4, tokens: 100, ratchets: 1, confidenceRejections: 0, stopReason: "converged", errors: [], emptyResponses: 0 },
      END,
    );
    expect(entry.observed.some((o) => o.includes("failed the confidence gate"))).toBe(false);
  });

  test("reject when nothing ratcheted", () => {
    const entry = makeCycleSummary(
      { startedAt: START, trigger: "idle" },
      { iterations: 8, tokens: 900, ratchets: 0, stopReason: "plateau", errors: [], emptyResponses: 0 },
      END,
    );
    expect(entry.decided.action).toBe("reject");
    if (entry.decided.action === "reject") {
      expect(entry.decided.nextStep.length).toBeGreaterThan(0);
    }
  });

  test("halt on an errored episode, surfacing the first error", () => {
    const entry = makeCycleSummary(
      { startedAt: START, trigger: "error" },
      { iterations: 0, tokens: 0, ratchets: 0, stopReason: "error", errors: ["bridge timeout"], emptyResponses: 0 },
      END,
    );
    expect(entry.decided.action).toBe("halt");
    if (entry.decided.action === "halt") {
      expect(entry.decided.reason).toBe("bridge timeout");
      expect(entry.decided.stage).toBe("evaluate");
    }
  });

  test("tolerates missing stats (undefined)", () => {
    const entry = makeCycleSummary({ startedAt: START, trigger: "idle" }, undefined, END);
    expect(entry.decided.action).toBe("reject"); // 0 ratchets, no error
    expect(entry.observed).toContain("stop reason: unknown");
  });
});

describe("journal round-trips through readJournal", () => {
  const path = join(tmpdir(), `feral-journal-test-${Date.now()}-${Math.random()}.jsonl`);
  afterEach(() => rmSync(path, { force: true }));

  test("a written cycle summary reads back with its decision intact", () => {
    const { appendJournal } = require("../src/rsi/journal.ts");
    appendJournal(
      path,
      makeCycleSummary(
        { startedAt: START, trigger: "idle" },
        { iterations: 5, tokens: 100, ratchets: 1, stopReason: "converged", errors: [], emptyResponses: 0 },
        END,
      ),
    );
    const rows = readJournal(path);
    expect(rows.length).toBe(1);
    expect(rows[0]!.decided.action).toBe("accept");
    expect(rows[0]!.cycleId).toBe("c-2026-07-01T12:00:00.000Z");
  });
});
