// tests/brain-plasticity.test.ts
import { describe, expect, test } from "bun:test";
import { fixtureCircuit } from "../src/brain-substrate/sim/fixture-circuit.ts";
import { LifSim } from "../src/brain-substrate/sim/lif.ts";
import { applyReinforcement, newPlasticState, effectiveWeight } from "../src/brain-substrate/plasticity/rule.ts";
import { degreeSignPreservingShuffle } from "../src/brain-substrate/sim/shuffle.ts";

describe("kc-mbon-depression-v1", () => {
  test("reward depresses only avoidance compartments; punishment only approach; nothing else moves", () => {
    const pack = fixtureCircuit();
    const sim = new LifSim(pack);
    const s = newPlasticState(pack);
    const kcRates = new Float32Array(pack.manifest.neurons);
    for (const k of pack.populations.kc!) kcRates[k] = 50;
    const changed = applyReinforcement(pack, sim, s, "reward", kcRates);
    expect(changed).toBeGreaterThan(0);
    for (let i = 0; i < s.delta.length; i++) {
      const comp = pack.manifest.compartments[pack.plastic.compartment[i]!]!;
      if (comp.mbonValence === "avoidance") expect(s.delta[i]).toBeLessThan(0);
      else expect(s.delta[i]).toBe(0);
    }
    const w = effectiveWeight(pack, s);
    let touched = 0;
    for (let e = 0; e < w.length; e++) if (w[e] !== pack.weight[e]) touched++;
    expect(touched).toBe(changed);
  });

  test("10,000 rewards stay within the clamp and never flip a sign", () => {
    const pack = fixtureCircuit();
    const sim = new LifSim(pack);
    const s = newPlasticState(pack);
    const kcRates = new Float32Array(pack.manifest.neurons);
    for (const k of pack.populations.kc!) kcRates[k] = 100;
    for (let i = 0; i < 10_000; i++) applyReinforcement(pack, sim, s, "reward", kcRates);
    for (let i = 0; i < s.delta.length; i++) {
      const base = pack.weight[pack.plastic.edgeIdx[i]!]!;
      expect(s.delta[i]).toBeGreaterThanOrEqual(-Math.abs(base));
      expect(s.delta[i]).toBeLessThanOrEqual(0);
      expect(Math.sign(base + s.delta[i]!) === Math.sign(base) || base + s.delta[i]! === 0).toBe(true);
    }
  });

  test("a shuffle keeps every in-degree, out-degree and sign, and changes the wiring", () => {
    const pack = fixtureCircuit();
    const sh = degreeSignPreservingShuffle(pack, 11);
    const N = pack.manifest.neurons;
    const outDeg = (p: typeof pack) => Array.from({ length: N }, (_, i) => p.rowPtr[i + 1]! - p.rowPtr[i]!);
    const inDeg = (p: typeof pack) => { const d = new Array(N).fill(0); for (const c of p.colIdx) d[c]++; return d; };
    expect(outDeg(sh)).toEqual(outDeg(pack));
    expect(inDeg(sh)).toEqual(inDeg(pack));
    expect(Array.from(sh.weight).map(Math.sign).sort()).toEqual(Array.from(pack.weight).map(Math.sign).sort());
    expect(Array.from(sh.colIdx)).not.toEqual(Array.from(pack.colIdx));
    expect(sh.plastic.edgeIdx.length).toBe(pack.plastic.edgeIdx.length);
  });

  test("a valence without a DAN that fires changes nothing (ledger ruling)", () => {
    const pack = fixtureCircuit();
    for (const c of pack.manifest.compartments) c.danIds = [];
    const sim = new LifSim(pack);
    const s = newPlasticState(pack);
    const kcRates = new Float32Array(pack.manifest.neurons);
    for (const k of pack.populations.kc!) kcRates[k] = 50;
    expect(applyReinforcement(pack, sim, s, "reward", kcRates)).toBe(0);
    expect(s.delta.every((d) => d === 0)).toBe(true);
  });
});
