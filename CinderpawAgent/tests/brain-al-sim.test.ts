import { describe, expect, it } from "bun:test";
import { SHIU_2024, type BrainPack, type Manifest } from "../src/brain-substrate/pack/types.ts";
import { AlSim } from "../src/brain-substrate/sim/al-sim.ts";
import { LifSim } from "../src/brain-substrate/sim/lif.ts";

// 0 ORN_A, 1 ORN_B, 2 PN_A, 3 patchy LN, 4 global inhibitory LN
function tinyAl(): BrainPack {
  const edges: [number, number, number][] = [[0, 2, 40], [0, 3, 40], [1, 3, 40], [3, 2, -40], [4, 0, -40]];
  const N = 5, rowPtr = new Int32Array(N + 1), colIdx = new Int32Array(edges.length), weight = new Float32Array(edges.length);
  edges.forEach(([s, d, c], e) => { rowPtr[s + 1]!++; colIdx[e] = d; weight[e] = c * SHIU_2024.wSyn; });
  for (let i = 0; i < N; i++) rowPtr[i + 1]! += rowPtr[i]!;
  const manifest = { neurons: N, edges: edges.length, simParams: SHIU_2024, populations: {}, compartments: [] } as unknown as Manifest;
  return { manifest, dir: "", csrSha256: "", rowPtr, colIdx, weight, plastic: { edgeIdx: new Int32Array(), src: new Int32Array(), compartment: new Int8Array() }, populations: {} };
}
const synapses = [
  { pre: 0, post: 3, glomerulus: "A", synapses: 40 },
  { pre: 1, post: 3, glomerulus: "B", synapses: 40 },
  { pre: 3, post: 2, glomerulus: "A", synapses: 40 },
];
const drive = (sim: LifSim, ids: number[], ms: number) => { sim.inject(Int32Array.from(ids), new Float32Array(ids.length).fill(2)); sim.step(ms); };

describe("AlSim", () => {
  it("is LifSim when no mechanism is switched on", () => {
    const a = new AlSim(tinyAl()), b = new LifSim(tinyAl());
    drive(a, [0, 4], 100); drive(b, [0, 4], 100);
    expect(a.totalSpikes()).toBe(b.totalSpikes());
    expect(Array.from(a.rates(Int32Array.from([0, 2, 3, 4])))).toEqual(Array.from(b.rates(Int32Array.from([0, 2, 3, 4]))));
  });
  it("a patchy compartment depolarises only from input in its own glomerulus, and never spikes", () => {
    const sim = new AlSim(tinyAl(), { patchy: [3], synapses });
    drive(sim, [0], 100);
    const d = sim.compartmentDepolarisation(), iA = sim.compGlom.indexOf("A"), iB = sim.compGlom.indexOf("B");
    expect(d[iA]!).toBeGreaterThan(0.5);
    expect(d[iB]!).toBeCloseTo(0, 6);
    expect(sim.rates(Int32Array.from([3]))[0]).toBe(0);
  });
  it("presynaptic inhibition lowers p and the ORN's effect on its PN, without inhibiting the ORN membrane", () => {
    const off = new AlSim(tinyAl(), { orns: [0, 1], localNeurons: [4] });
    const on = new AlSim(tinyAl(), { orns: [0, 1], localNeurons: [4], gHalf: 4 });
    drive(off, [0, 4], 400); drive(on, [0, 4], 400);
    expect(on.meanP([0])).toBeLessThan(0.9);
    expect(on.rates(Int32Array.from([0]))[0]!).toBeGreaterThanOrEqual(off.rates(Int32Array.from([0]))[0]!);
    expect(on.rates(Int32Array.from([2]))[0]!).toBeLessThan(off.rates(Int32Array.from([2]))[0]!);
  });
});
