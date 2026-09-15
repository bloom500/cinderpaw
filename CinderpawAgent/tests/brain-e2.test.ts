import { describe, expect, it } from "bun:test";
import { signPreservingTargetShuffle } from "../src/brain-substrate/bench/e1-emotion.ts";
import { features, jaccard, makeContexts, makeSequences, recoveryCount, ridgeFromGram, r2 } from "../src/brain-substrate/bench/e2-history.ts";
import { fixtureCircuit } from "../src/brain-substrate/sim/fixture-circuit.ts";

describe("E2 helpers", () => {
  it("contexts: A..D disjoint at 5%, A' shares half of A (Jaccard about 0.33)", () => {
    const kcs = Array.from({ length: 5177 }, (_, i) => i), c = makeContexts(kcs, 2001);
    expect(c.A.length).toBe(259);
    expect(c["A'"].length).toBe(259);
    expect(jaccard(c.A, c.B)).toBe(0);
    expect(jaccard(c.A, c["A'"])).toBeCloseTo(129 / 389, 6);
    expect(jaccard(c["A'"], c.B)).toBe(0);
  });

  it("ridge recovers a known linear map", () => {
    const seqs = makeSequences(40, 10, 9, "t"), J: Record<string, number> = {};
    for (const a of ["A", "B", "C", "D", "A'"]) for (const b of ["A", "B", "C", "D", "A'"]) J[`${a}|${b}`] = a === b ? 1 : 0;
    const X = seqs.flatMap((s) => features(s, "B1", 100, J)), p = X[0]!.length;
    const truth = X[0]!.map((_, i) => (i % 3) - 1);
    const y = X.map((row) => row.reduce((s, x, i) => s + x * truth[i]!, 0));
    const G = new Float64Array(p * p), b = new Float64Array(p);
    X.forEach((row, r) => row.forEach((x, i) => { b[i] += x * y[r]!; row.forEach((z, k) => { G[i * p + k] += x * z; }); }));
    const beta = ridgeFromGram(G, b, p, 1e-6);
    expect(r2(y, X.map((row) => row.reduce((s, x, i) => s + x * beta[i]!, 0)))).toBeGreaterThan(0.9999);
  });

  it("B0 is one-hot for base contexts and B2 sees history", () => {
    const J: Record<string, number> = {};
    for (const a of ["A", "B", "C", "D"]) for (const b of ["A", "B", "C", "D"]) J[`${a}|${b}`] = a === b ? 1 : 0;
    const s = makeSequences(1, 12, 3, "x")[0]!;
    expect(features(s, "B0", 1, J).every((row) => row.slice(1).reduce((t, x) => t + x, 0) === 1)).toBe(true);
    expect(features(s, "B2", 100, J)[0]!.length).toBe(1 + 16 + 4 + 16 * 8 + 8 + 16 * (4 + 16 * 8 + 8));
  });

  it("recovery counts events after the 4-event history; 21 means never", () => {
    expect(recoveryCount([9, 9, 9, 9, 5, 2, 1.05], 1)).toBe(3);
    expect(recoveryCount([9, 9, 9, 9, 5, 5], 1)).toBe(21);
  });

  it("the shuffle leaves kept edges untouched", () => {
    const p = fixtureCircuit(), keep = Int32Array.from([0, 1, 2]);
    const s = signPreservingTargetShuffle(p, 7, keep);
    keep.forEach((e) => expect(s.colIdx[e]).toBe(p.colIdx[e]!));
  });
});
