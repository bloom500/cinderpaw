/**
 * S3 (competence plan §2.6): the first campaign, on free fixtures, four arms
 * against the no-learning baseline. This test pins the HARNESS properties
 * (paired, matched, partitions held out, the pilot stops at the gate) and
 * prints the numbers. It does not assert that learning wins: that is H1, a
 * measurement, and a test that asserts a hypothesis is a hypothesis with a
 * green checkmark.
 *
 * Measured 13 Sep 2026, 12 paired seeds, 2 attempts per task, promotion =
 * two templates never seen in training:
 *   fixed 0.542 | fms 0.542 (retrieval cannot hit an unseen template) |
 *   brsi 0.625 (p=0.094, not significant) | both 0.917 (Δ=0.375, p<0.001)
 *   learning cost: fixed 169, fms 137, brsi 126, both 112 attempts.
 * Why brsi alone does not clear the gate: M0 keeps an accept rate per repair,
 * not per (repair, failure signature). Over-exploring in training teaches it
 * "fix-import-paths never works", true on dev and false on promotion. The
 * receipt carries the signature in `rationale`; M0 does not read it yet. A
 * receipt without conditions is an anecdote (plan §1). That is the next
 * change to the learner, and it is NOT made here, mid-pilot.
 */
import { describe, expect, test } from "bun:test";
import { ARMS, armWith } from "../src/rsi/infra/arms.ts";
import { runPairedCampaign, type CampaignManifest } from "../src/rsi/infra/campaign.ts";
import { partitionedFixtures } from "../src/rsi/infra/fixtures.ts";

const parts = partitionedFixtures(
  {
    development: ["missing-dep", "bad-env-name"],
    promotion: ["broken-import", "stale-engine"],
    final: [],
    transfer: [],
  },
  4,
);

const manifest = (cand: keyof typeof ARMS, seeds: number): CampaignManifest => ({
  id: `pilot-${cand}`,
  seeds: Array.from({ length: seeds }, (_, i) => i + 1),
  arms: ["fixed", cand],
  partitions: parts,
  usdCap: 0,
  wallMsCap: 60_000,
});

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe("the first campaign: four arms on free fixtures", () => {
  test("every arm pairs with the baseline on all five pilot seeds, and the pilot cannot clear the gate", async () => {
    const rows: string[] = [];
    for (const cand of ["fms", "brsi", "both"] as const) {
      const r = await runPairedCampaign(manifest(cand, 5), {
        fixed: armWith("fixed", { maxAttempts: 2 }),
        [cand]: armWith(cand, { maxAttempts: 2 }),
      });
      expect(r.matched).toBe(true);
      expect(r.samples).toHaveLength(5);
      expect(r.stopped).toBeUndefined();
      expect(r.ledger.fixed!.usd).toBe(0);
      expect(r.gate.accept).toBe(false);
      expect(r.gate.reason).toContain("insufficient samples");
      rows.push(
        `${cand.padEnd(5)} fixed=${mean(r.samples.map((s) => s.baseline)).toFixed(3)} ` +
          `${cand}=${mean(r.samples.map((s) => s.candidate)).toFixed(3)} ` +
          `learn-cost fixed=${r.ledger.fixed!.tokens} ${cand}=${r.ledger[cand]!.tokens}`,
      );
    }
    console.log("[pilot, 5 seeds]\n" + rows.join("\n"));
  });

  test("the same seed gives the same paired sample twice", async () => {
    const a = await runPairedCampaign(manifest("both", 3), { fixed: ARMS.fixed, both: ARMS.both });
    const b = await runPairedCampaign(manifest("both", 3), { fixed: ARMS.fixed, both: ARMS.both });
    expect(a.samples).toEqual(b.samples);
    expect(a.manifestHash).toBe(b.manifestHash);
  });

  test("retrieval alone cannot help on a template it never saw: fms equals fixed", async () => {
    const r = await runPairedCampaign(manifest("fms", 12), {
      fixed: armWith("fixed", { maxAttempts: 2 }),
      fms: armWith("fms", { maxAttempts: 2 }),
    });
    for (const s of r.samples) expect(s.candidate).toBe(s.baseline);
    // But it learns cheaper: on the training partition it stops searching
    // once it has seen a failure before.
    expect(r.ledger.fms!.tokens).toBeLessThan(r.ledger.fixed!.tokens);
  });

  test("with the whole catalog allowed, every arm solves everything and only cost differs", async () => {
    const r = await runPairedCampaign(manifest("both", 5), { fixed: ARMS.fixed, both: ARMS.both });
    for (const s of r.samples) {
      expect(s.baseline).toBe(1);
      expect(s.candidate).toBe(1);
    }
    expect(r.ledger.both!.tokens).toBeLessThan(r.ledger.fixed!.tokens);
  });
});
