/**
 * A 40-neuron hand-built circuit with every role, in memory, for tests that
 * must not depend on any species pack (spec section 8.5a).
 *
 * Neuron ids and wiring (synapse count, sign):
 *
 *   0..7    sensory        s -> kc 8 + (3s + j) mod 12, j in 0..2     40, +
 *   8..19   kc             k -> mbon 20 + (k mod 4), 20 + ((k+1) mod 4)  40, +  (plastic)
 *   20..23  mbon           20, 21 approach; 22, 23 avoidance
 *   24..27  dan            d -> mbon 20 + (d - 24)                       3, +
 *                          24, 25 approach; 26, 27 avoidance
 *   28..35  persistent     r -> ring neighbours r +- 1 (mod 8)           7, +
 *                          r -> opposite r + 4 (mod 8)                    6, -
 *   36..39  neuromodulator m -> ring 28 + 2(m - 36), 28 + 2(m - 36) + 1  5, +
 *
 * Compartments: one per MBON, danIds = the two DANs of that MBON's valence.
 * Weight = sign * count * SHIU_2024.wSyn. Synapse counts on the sensory -> kc
 * -> mbon path are 40 so that a few inputs at ~150 Hz carry a neuron over the
 * 7 mV threshold under the reference gain (w * tauS / tauM per spike).
 */
import { SHIU_2024, type BrainPack, type Compartment, type Manifest } from "../pack/types.ts";

const SENSORY = [0, 1, 2, 3, 4, 5, 6, 7];
const KC = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
const MBON = [20, 21, 22, 23];
const DAN = [24, 25, 26, 27];
const RING = [28, 29, 30, 31, 32, 33, 34, 35];
const NM = [36, 37, 38, 39];
const N = 40;

export function fixtureCircuit(): BrainPack {
  const wSyn = SHIU_2024.wSyn;
  // [src, dst, signed synapse count]
  const edges: [number, number, number][] = [];
  for (const s of SENSORY) for (let j = 0; j < 3; j++) edges.push([s, KC[(3 * s + j) % 12]!, 40]);
  for (const k of KC) {
    edges.push([k, MBON[(k - 8) % 4]!, 40]);
    edges.push([k, MBON[(k - 8 + 1) % 4]!, 40]);
  }
  for (const d of DAN) edges.push([d, MBON[d - 24]!, 3]);
  for (const r of RING) {
    const i = r - 28;
    edges.push([r, RING[(i + 1) % 8]!, 7]);
    edges.push([r, RING[(i + 7) % 8]!, 7]);
    edges.push([r, RING[(i + 4) % 8]!, -6]);
  }
  for (const m of NM) {
    edges.push([m, RING[2 * (m - 36)]!, 5]);
    edges.push([m, RING[2 * (m - 36) + 1]!, 5]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const rowPtr = new Int32Array(N + 1);
  const colIdx = new Int32Array(edges.length);
  const weight = new Float32Array(edges.length);
  const plasticIdx: number[] = [], plasticSrc: number[] = [], plasticComp: number[] = [];
  edges.forEach(([src, dst, count], e) => {
    rowPtr[src + 1]!++;
    colIdx[e] = dst;
    weight[e] = count * wSyn;
    if (KC.includes(src) && MBON.includes(dst)) {
      plasticIdx.push(e);
      plasticSrc.push(src);
      plasticComp.push(dst - 20);
    }
  });
  for (let i = 0; i < N; i++) rowPtr[i + 1]! += rowPtr[i]!;

  const compartments: Compartment[] = MBON.map((m, i) => ({
    id: `mbon-${m}`,
    mbonValence: i < 2 ? "approach" : "avoidance",
    danIds: i < 2 ? [24, 25] : [26, 27],
  }));
  const populations = {
    sensory: SENSORY, kc: KC, mbon: MBON, dan: DAN, "persistent-state": RING, neuromodulator: NM,
  };
  const manifest: Manifest = {
    packId: "fixture-40",
    species: "none (hand-built test circuit)",
    source: { name: "fixture-circuit.ts", doi: "", release: "1" },
    completeness: "region",
    packFormatVersion: 1,
    simulatorAbiVersion: 1,
    license: "Apache-2.0",
    attributionFile: "",
    neurons: N,
    edges: edges.length,
    plasticEdges: plasticIdx.length,
    simParams: SHIU_2024,
    seed: 0,
    populations,
    compartments,
    plasticity: { rule: "kc-mbon-depression-v1", eta: 0.05, maxDelta: null },
    sha256: { "csr.bin": "fixture", "plastic.bin": "fixture" },
  };
  return {
    manifest,
    dir: "",
    csrSha256: "fixture",
    rowPtr,
    colIdx,
    weight,
    plastic: {
      edgeIdx: Int32Array.from(plasticIdx),
      src: Int32Array.from(plasticSrc),
      compartment: Int8Array.from(plasticComp),
    },
    populations: Object.fromEntries(
      Object.entries(populations).map(([role, ids]) => [role, Int32Array.from(ids)]),
    ) as BrainPack["populations"],
  };
}
