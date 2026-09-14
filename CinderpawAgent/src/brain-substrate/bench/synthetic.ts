/**
 * The decisive experiment (spec section 7, plasticity row): learn 200 patterns
 * with a valence each, push 500 unrelated patterns through the same synapses,
 * then ask the brain what each learned pattern meant. Three wirings, one rule:
 * real, degree/sign shuffled, and a dense KC->MBON block with no topology.
 *
 * Deviation from the plan's step 7, recorded in the Task 3 report: the plan
 * paired each key with an arbitrary value vector, but a depression-only
 * KC->MBON rule can only learn "this pattern means reward or punishment", so
 * that is what is measured. Chance is 0.5.
 */
import { mulberry32 } from "../../memory/fractal/prng.ts";
import type { BrainPack } from "../pack/types.ts";
import { applyReinforcement, effectiveWeight, newPlasticState, type Valence } from "../plasticity/rule.ts";
import { LifSim } from "../sim/lif.ts";
import { embeddingToCurrent, makeProjection, readoutFromRest } from "../seams/pattern.ts";

export const EMBEDDING_DIMS = 384;

export interface SyntheticResult {
  condition: "real" | "shuffled" | "dense";
  plasticity: boolean;
  seed: number;
  shuffleSeed?: number;
  pairs: number;
  interference: number;
  /** Fraction of learned patterns whose valence the MBON readout gets right after interference; ties count half. */
  accuracy: number;
  /** Fraction of KCs firing per pattern, mean over the learned set (5 to 10% is the biological range). */
  kcSparsity: number;
  /** Mean absolute shift of the approach-minus-avoidance readout, learned patterns, in Hz. */
  meanShiftHz: number;
}

export interface SyntheticOpts {
  condition: SyntheticResult["condition"];
  seed: number;
  shuffleSeed?: number;
  pairs?: number;
  interference?: number;
  plasticity: boolean;
}

function unitVector(rand: () => number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMS);
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    const u = 1 - rand(), w = rand();
    v[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
    norm += v[i]! * v[i]!;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

/** Which MBONs sit in approach and in avoidance compartments, read off the plastic list. */
function mbonSides(pack: BrainPack): { approach: Int32Array; avoidance: Int32Array } {
  const side = new Map<number, "approach" | "avoidance">();
  for (let i = 0; i < pack.plastic.edgeIdx.length; i++) {
    const mbon = pack.colIdx[pack.plastic.edgeIdx[i]!]!;
    side.set(mbon, pack.manifest.compartments[pack.plastic.compartment[i]!]!.mbonValence);
  }
  const pick = (v: "approach" | "avoidance") => Int32Array.from([...side].filter(([, s]) => s === v).map(([m]) => m));
  return { approach: pick("approach"), avoidance: pick("avoidance") };
}

export function runPlasticityBench(pack: BrainPack, opts: SyntheticOpts): SyntheticResult {
  const pairs = opts.pairs ?? 200;
  const interference = opts.interference ?? 500;
  const rand = mulberry32(opts.seed);
  const sensory = pack.populations.sensory!;
  const mbon = pack.populations.mbon!;
  const kc = pack.populations.kc!;
  const proj = makeProjection(EMBEDDING_DIMS, sensory.length, opts.seed);
  const sides = mbonSides(pack);
  const mbonPos = new Map<number, number>();
  mbon.forEach((m, i) => mbonPos.set(m, i));
  const meanOf = (rates: Float32Array, ids: Int32Array) =>
    ids.length === 0 ? 0 : Array.from(ids).reduce((a, m) => a + rates[mbonPos.get(m)!]!, 0) / ids.length;
  const score = (rates: Float32Array) => meanOf(rates, sides.approach) - meanOf(rates, sides.avoidance);

  const keys: Float32Array[] = [], valences: Valence[] = [];
  for (let i = 0; i < pairs; i++) {
    keys.push(embeddingToCurrent(unitVector(rand), proj, sensory.length));
    valences.push(rand() < 0.5 ? "reward" : "punishment");
  }

  const sim = new LifSim(pack);
  const s = newPlasticState(pack);
  const N = pack.manifest.neurons;

  // What the untrained brain says about each key; learning is measured as a shift from this.
  const before = keys.map((k) => score(readoutFromRest(pack, sim, k).mbon));
  let sparsity = 0;

  const learn = (pattern: Float32Array, valence: Valence, countSparsity: boolean) => {
    const { kc: kcRates } = readoutFromRest(pack, sim, pattern);
    if (countSparsity) sparsity += kcRates.filter((r) => r > 0).length / kc.length / pairs;
    if (!opts.plasticity) return;
    const full = new Float32Array(N);
    kc.forEach((id, i) => { full[id] = kcRates[i]!; });
    if (applyReinforcement(pack, sim, s, valence, full) > 0) sim.setEffectiveWeight(effectiveWeight(pack, s));
  };
  keys.forEach((k, i) => learn(k, valences[i]!, true));
  for (let i = 0; i < interference; i++) {
    learn(embeddingToCurrent(unitVector(rand), proj, sensory.length), rand() < 0.5 ? "reward" : "punishment", false);
  }

  let correct = 0, shift = 0;
  keys.forEach((k, i) => {
    const d = score(readoutFromRest(pack, sim, k).mbon) - before[i]!;
    shift += Math.abs(d);
    // reward depresses avoidance MBONs, so the readout moves up; punishment moves it down
    if (d === 0) correct += 0.5;
    else if ((d > 0) === (valences[i] === "reward")) correct += 1;
  });

  return {
    condition: opts.condition,
    plasticity: opts.plasticity,
    seed: opts.seed,
    shuffleSeed: opts.shuffleSeed,
    pairs,
    interference,
    accuracy: correct / pairs,
    kcSparsity: sparsity,
    meanShiftHz: shift / pairs,
  };
}

/** "Hebbian somewhere, no topology": every KC to every MBON at the median plastic magnitude, everything else as is. */
export function densePlasticPack(pack: BrainPack): BrainPack {
  const N = pack.manifest.neurons;
  const isPlastic = new Uint8Array(pack.colIdx.length);
  for (const e of pack.plastic.edgeIdx) isPlastic[e] = 1;
  const mags = Array.from(pack.plastic.edgeIdx, (e) => Math.abs(pack.weight[e]!)).sort((a, b) => a - b);
  const median = mags[Math.floor(mags.length / 2)] ?? pack.manifest.simParams.wSyn;
  const compartmentOfMbon = new Map<number, number>();
  for (let i = 0; i < pack.plastic.edgeIdx.length; i++) {
    compartmentOfMbon.set(pack.colIdx[pack.plastic.edgeIdx[i]!]!, pack.plastic.compartment[i]!);
  }
  const kcSet = new Set(pack.populations.kc ?? []);
  const rows: [number, number, number][] = [];
  for (let i = 0; i < N; i++) {
    for (let e = pack.rowPtr[i]!; e < pack.rowPtr[i + 1]!; e++) if (!isPlastic[e]) rows.push([i, pack.colIdx[e]!, pack.weight[e]!]);
    if (kcSet.has(i)) for (const m of compartmentOfMbon.keys()) rows.push([i, m, median]);
  }
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const rowPtr = new Int32Array(N + 1);
  const colIdx = new Int32Array(rows.length);
  const weight = new Float32Array(rows.length);
  const edgeIdx: number[] = [], src: number[] = [], comp: number[] = [];
  rows.forEach(([r, c, w], k) => {
    rowPtr[r + 1] = rowPtr[r + 1]! + 1;
    colIdx[k] = c;
    weight[k] = w;
    if (kcSet.has(r) && compartmentOfMbon.has(c)) { edgeIdx.push(k); src.push(r); comp.push(compartmentOfMbon.get(c)!); }
  });
  for (let i = 0; i < N; i++) rowPtr[i + 1] = rowPtr[i + 1]! + rowPtr[i]!;
  return {
    ...pack,
    manifest: { ...pack.manifest, edges: rows.length, plasticEdges: edgeIdx.length, source: { ...pack.manifest.source, release: "dense KC->MBON" } },
    dir: "",
    csrSha256: "dense",
    rowPtr, colIdx, weight,
    plastic: { edgeIdx: Int32Array.from(edgeIdx), src: Int32Array.from(src), compartment: Int8Array.from(comp) },
  };
}
