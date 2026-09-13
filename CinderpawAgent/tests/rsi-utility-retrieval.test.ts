/**
 * Competence plan §3.3, the measurement: retrieval with and without the
 * utility ledger, on the `fms` arm.
 *
 * On clean memory the ledger cannot move anything: every accepted receipt
 * in these fixtures is true, so "looked relevant" and "helped" agree, and
 * `fms-u` must equal `fms` byte for byte. The knob earns its keep only when
 * memory holds receipts that look right and are not. `claimedAcceptRate`
 * plants those: a failed attempt recorded as an accept without the
 * verifier (the "[claimed, not verified]" row of §2.2). Retrieval by
 * similarity cannot tell a claimed receipt from a verified one, because
 * they carry the same signature. The ledger can, because it remembers
 * whether the task closed verified after that leaf was shown.
 *
 * Numbers are printed, not asserted: the assertion here is the harness
 * property (identity on clean memory) plus the direction under noise.
 */
import { describe, expect, test } from "bun:test";
import { armWith } from "../src/rsi/infra/arms.ts";
import { runPairedCampaign } from "../src/rsi/infra/campaign.ts";
import { partitionedFixtures } from "../src/rsi/infra/fixtures.ts";

// Repeated families (as H5): retrieval fires on promotion only for a
// signature it has met, so this is the partition where it can be wrong.
const families = ["missing-dep", "bad-env-name", "broken-import", "stale-engine"] as const;
const dev = partitionedFixtures({ development: [...families], promotion: [], final: [], transfer: [] }, 6);
const promo = partitionedFixtures({ development: [], promotion: [...families], final: [], transfer: [] }, 3, 5000);
const partitions = { ...dev, promotion: promo.promotion };
const seeds = Array.from({ length: 12 }, (_, i) => i + 1);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

async function pair(cand: "fms" | "fms-u", noise: number) {
  const opts = { maxAttempts: 2, claimedAcceptRate: noise };
  return runPairedCampaign(
    { id: `u-${cand}-${noise}`, seeds, arms: ["fixed", cand], partitions, usdCap: 0, wallMsCap: 60_000 },
    { fixed: armWith("fixed", opts), [cand]: armWith(cand, opts) },
  );
}

describe("§3.3 utility-scored retrieval on the fms arm", () => {
  test("on clean memory fms-u is fms exactly", async () => {
    const a = await pair("fms", 0);
    const b = await pair("fms-u", 0);
    expect(b.samples.map((s) => s.candidate)).toEqual(a.samples.map((s) => s.candidate));
    expect(b.ledger["fms-u"]!.tokens).toBe(a.ledger.fms!.tokens);
  });

  test("with claimed receipts in memory, the ledger recovers what similarity loses", async () => {
    const rows: string[] = [];
    let last = { fms: 0, u: 0 };
    for (const noise of [0, 0.25, 0.5]) {
      const a = await pair("fms", noise);
      const b = await pair("fms-u", noise);
      const fms = mean(a.samples.map((s) => s.candidate));
      const u = mean(b.samples.map((s) => s.candidate));
      rows.push(
        `claimed=${noise.toFixed(2)} fixed=${mean(a.samples.map((s) => s.baseline)).toFixed(3)} ` +
          `fms=${fms.toFixed(3)} fms-u=${u.toFixed(3)} ` +
          `learn-cost fms=${a.ledger.fms!.tokens} fms-u=${b.ledger["fms-u"]!.tokens}`,
      );
      last = { fms, u };
    }
    console.log("[§3.3, 12 seeds, 2 attempts, repeated families]\n" + rows.join("\n"));
    expect(last.u).toBeGreaterThan(last.fms);
  });
});
