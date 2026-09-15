import { describe, expect, it } from "bun:test";
import { delta, signPreservingTargetShuffle } from "../src/brain-substrate/bench/e1-emotion.ts";
import { fixtureCircuit } from "../src/brain-substrate/sim/fixture-circuit.ts";

describe("E1 helpers", () => {
  it("the shuffle keeps every neuron's in- and out-degree and every edge's sign", () => {
    const p = fixtureCircuit(), s = signPreservingTargetShuffle(p, 7);
    const inDeg = (cols: Int32Array) => { const d = new Array(p.manifest.neurons).fill(0); cols.forEach((c) => d[c]++); return d; };
    expect(inDeg(s.colIdx)).toEqual(inDeg(p.colIdx));
    expect(Array.from(s.rowPtr)).toEqual(Array.from(p.rowPtr));
    const signIn = (cols: Int32Array, pos: boolean) => { const d = new Array(p.manifest.neurons).fill(0); cols.forEach((c, e) => { if (p.weight[e]! > 0 === pos) d[c]++; }); return d; };
    expect(signIn(s.colIdx, false)).toEqual(signIn(p.colIdx, false));
    expect(Array.from(s.colIdx)).not.toEqual(Array.from(p.colIdx));
  });
  it("delta is the window mean minus the 200 ms baseline (4 bins of 50 ms)", () => {
    expect(delta([1, 1, 1, 1, 5, 5, 5, 5, 1], 0, 200)).toBe(4);
  });
});
