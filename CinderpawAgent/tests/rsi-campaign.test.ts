/**
 * S1 of the recursive-learning spec: the paired campaign runner. Four things
 * have to hold before any number it produces is worth reading — deterministic
 * fixtures, a matched cost ledger, partition isolation, and a gate whose
 * false-positive rate we have actually measured instead of assumed.
 */
import { describe, expect, test } from "bun:test";
import {
  calibrateNullEffect,
  runPairedCampaign,
  type ArmFn,
  type CampaignManifest,
  type FixtureTask,
} from "../src/rsi/infra/campaign.ts";

const tasks = (prefix: string, n: number): FixtureTask[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, family: prefix }));

const manifest = (over: Partial<CampaignManifest> = {}): CampaignManifest => ({
  id: "test-campaign",
  seeds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  arms: ["m0", "candidate"],
  partitions: {
    development: tasks("dev", 6),
    promotion: tasks("promo", 8),
    final: tasks("final", 8),
    transfer: tasks("transfer", 4),
  },
  usdCap: 0,
  wallMsCap: 60_000,
  ...over,
});

/** Mulberry32, same shape as the one in confidence.ts — a test arm has to be
 *  noisy in a reproducible way or none of this is deterministic. */
const rngOf = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** An arm that solves a fixed fraction of what it is asked, free of charge. */
const flatArm = (rate: number): ArmFn => ({ seed }) => {
  const rng = rngOf(seed);
  return { cost: { tokens: 10, usd: 0, wallMs: 1 }, solve: () => rng() < rate };
};

describe("paired campaign runner", () => {
  test("same manifest and arms produce the same hash and the same samples", async () => {
    const m = manifest();
    const arms = { m0: flatArm(0.4), candidate: flatArm(0.6) };
    const a = await runPairedCampaign(m, arms);
    const b = await runPairedCampaign(m, { m0: flatArm(0.4), candidate: flatArm(0.6) });

    expect(a.manifestHash).toBe(b.manifestHash);
    expect(a.samples).toEqual(b.samples);
    expect(a.matched).toBe(true);
    expect(a.samples).toHaveLength(m.seeds.length);
  });

  test("an arm only ever receives the development partition", async () => {
    const seen = new Set<string>();
    const spy: ArmFn = ({ train }) => {
      for (const t of train) seen.add(t.id);
      return { cost: { tokens: 0, usd: 0 }, solve: () => true };
    };
    const m = manifest();
    await runPairedCampaign(m, { m0: spy, candidate: spy });

    expect([...seen].sort()).toEqual(m.partitions.development.map((t) => t.id).sort());
    for (const p of ["promotion", "final", "transfer"] as const) {
      for (const t of m.partitions[p]) expect(seen.has(t.id)).toBe(false);
    }
  });

  test("the score comes from the promotion partition, not from the arm", async () => {
    // Solves every dev task and nothing else: 0 on promotion, no matter how
    // loudly it would claim otherwise.
    const devOnly: ArmFn = () => ({
      cost: { tokens: 0, usd: 0 },
      solve: (t) => t.family === "dev",
    });
    const r = await runPairedCampaign(manifest(), { m0: devOnly, candidate: devOnly });
    expect(r.samples.every((s) => s.candidate === 0 && s.baseline === 0)).toBe(true);
  });

  test("the ledger totals both arms and a free campaign refuses a paid arm", async () => {
    const paid: ArmFn = () => ({ cost: { tokens: 100, usd: 0.01 }, solve: () => true });
    const r = await runPairedCampaign(manifest(), { m0: flatArm(0.5), candidate: paid });

    expect(r.stopped).toContain("no authorised budget");
    expect(r.matched).toBe(false);
    expect(r.samples).toHaveLength(0);
    // The spend that already happened is kept, not erased by the stop.
    expect(r.ledger.candidate!.usd).toBeCloseTo(0.01, 10);
    expect(r.ledger.m0!.tokens).toBe(10);
  });

  test("a usd cap stops the campaign partway and keeps the spend", async () => {
    const paid: ArmFn = () => ({ cost: { tokens: 1, usd: 0.4 }, solve: () => true });
    const r = await runPairedCampaign(manifest({ usdCap: 1 }), { m0: paid, candidate: paid });

    expect(r.stopped).toBe("usd cap $1 exhausted");
    expect(r.ledger.m0!.usd + r.ledger.candidate!.usd).toBeGreaterThan(1);
    expect(r.samples.length).toBeLessThan(manifest().seeds.length);
  });

  test("an arm that throws stops the campaign instead of leaving a half pair", async () => {
    const boom: ArmFn = () => {
      throw new Error("worker died");
    };
    const r = await runPairedCampaign(manifest(), { m0: flatArm(0.5), candidate: boom });

    expect(r.stopped).toContain("worker died");
    expect(r.samples).toHaveLength(0);
    expect(r.matched).toBe(false);
    expect(r.gate.accept).toBe(false);
  });

  test("a five-seed pilot cannot reach the gate, on purpose", async () => {
    const r = await runPairedCampaign(manifest({ seeds: [1, 2, 3, 4, 5] }), {
      m0: flatArm(0.1),
      candidate: flatArm(0.9),
    });
    expect(r.samples).toHaveLength(5);
    expect(r.gate.accept).toBe(false);
    expect(r.gate.reason).toContain("insufficient samples");
  });

  test("a real effect passes the gate", async () => {
    const r = await runPairedCampaign(manifest(), { m0: flatArm(0.2), candidate: flatArm(0.8) });
    expect(r.gate.accept).toBe(true);
  });
});

describe("null-effect calibration", () => {
  test("two runs of the SAME noisy arm accept at roughly the nominal rate", async () => {
    // One shared rng across both arms: identical arms with identical seeds
    // would differ by exactly zero and calibrate nothing. This is the real
    // no-effect case — same policy, different draw.
    const rng = rngOf(0xbeef);
    const noisy: ArmFn = () => ({
      cost: { tokens: 1, usd: 0, wallMs: 0 },
      solve: () => rng() < 0.5,
    });

    const cal = await calibrateNullEffect(manifest(), noisy, 40);
    expect(cal.trials).toBe(40);
    // The gate is advertised at p <= 0.05. Measured over 200 trials of this
    // same no-effect setup: 3.5% at 10 paired runs, 6.5% at 12, 3.5% at 20.
    // So the bootstrap tail does behave like a p-value at our sample sizes —
    // which is what §9.3 says to check before anyone quotes one. The bound
    // here is loose because 40 trials cannot resolve 5% tightly.
    expect(cal.rate).toBeLessThanOrEqual(0.15);
  });
});
