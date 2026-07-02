/**
 * Faza 4 Slice 3 — LoRA eval gate verdict: Tier 0 floor + confidence reuse.
 */

import { describe, expect, test } from "bun:test";
import { evaluateLoraGate } from "../src/rsi/lora-eval-gate.ts";
import type { PairedSample } from "../src/rsi/confidence.ts";

/** 12 paired samples where the candidate beats the baseline by a clear,
 *  low-variance margin — comfortably past the confidence gate. */
function clearWin(): PairedSample[] {
  return Array.from({ length: 12 }, () => ({ candidate: 0.9, baseline: 0.6 }));
}

/** 12 paired samples with no real difference — the gate must reject. */
function noDifference(): PairedSample[] {
  return Array.from({ length: 12 }, (_, i) => ({
    candidate: 0.7 + (i % 2 === 0 ? 0.01 : -0.01),
    baseline: 0.7,
  }));
}

describe("evaluateLoraGate", () => {
  test("Tier 0 failure rejects outright, before statistics", () => {
    const r = evaluateLoraGate(
      { passed: false, failedSpecIds: ["tier0/identity_honesty"] },
      clearWin(),
    );
    expect(r.verdict).toBe("reject");
    expect(r.reason).toContain("Tier 0");
    expect(r.reason).toContain("tier0/identity_honesty");
    expect(r.confidence).toBeUndefined(); // stats never ran
    expect(r.humanApprovalRequired).toBe(true);
  });

  test("clear statistical win + Tier 0 pass → recommend_promote", () => {
    const r = evaluateLoraGate({ passed: true }, clearWin());
    expect(r.verdict).toBe("recommend_promote");
    expect(r.confidence?.accept).toBe(true);
    // Human is STILL required at L2 — a recommendation is not a promotion.
    expect(r.humanApprovalRequired).toBe(true);
  });

  test("no real improvement → reject with the confidence reason", () => {
    const r = evaluateLoraGate({ passed: true }, noDifference());
    expect(r.verdict).toBe("reject");
    expect(r.confidence?.accept).toBe(false);
  });

  test("too few samples → insufficient_evidence, not reject", () => {
    const few: PairedSample[] = [
      { candidate: 0.9, baseline: 0.6 },
      { candidate: 0.9, baseline: 0.6 },
    ];
    const r = evaluateLoraGate({ passed: true }, few);
    expect(r.verdict).toBe("insufficient_evidence");
    expect(r.reason).toContain("insufficient samples");
  });

  test("human approval is required on every verdict at L2", () => {
    expect(evaluateLoraGate({ passed: true }, clearWin()).humanApprovalRequired).toBe(true);
    expect(evaluateLoraGate({ passed: true }, noDifference()).humanApprovalRequired).toBe(true);
    expect(evaluateLoraGate({ passed: false }, clearWin()).humanApprovalRequired).toBe(true);
  });
});
