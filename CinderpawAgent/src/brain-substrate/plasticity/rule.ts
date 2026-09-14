/**
 * kc-mbon-depression-v1 (spec section 4). Aso et al. 2014 compartment logic,
 * Hige et al. 2015 depression: reward gates the compartments whose MBON reads
 * "avoidance", punishment gates "approach". In a gated compartment the DANs are
 * driven for 20 ms; only if they actually fired do the KC->MBON edges from
 * active KCs weaken, and only down to a floor. Nothing ever strengthens and
 * no edge outside plastic.bin is touched.
 */
import type { BrainPack } from "../pack/types.ts";
import type { LifSim } from "../sim/lif.ts";
import type { PlasticState } from "./state.ts";

export { newPlasticState, effectiveWeight, type PlasticState } from "./state.ts";

export type Valence = "reward" | "punishment";

const DAN_DRIVE_MV_PER_MS = 2;
const DAN_DRIVE_MS = 20;

/** Drives the gated compartments' DANs for 20 ms, then depresses their KC->MBON edges. Returns edges changed. */
export function applyReinforcement(
  pack: BrainPack,
  sim: LifSim,
  s: PlasticState,
  valence: Valence,
  kcRates: Float32Array,
  opts: { eta?: number; maxDelta?: number | null } = {},
): number {
  const { compartments, plasticity } = pack.manifest;
  const eta = opts.eta ?? plasticity.eta;
  const maxDelta = opts.maxDelta === undefined ? plasticity.maxDelta : opts.maxDelta;
  const gatedValence = valence === "reward" ? "avoidance" : "approach";

  const gated = compartments.map((c) => c.mbonValence === gatedValence);
  const danIds = new Set<number>();
  compartments.forEach((c, ci) => {
    if (gated[ci]) for (const d of c.danIds) danIds.add(d);
  });
  const dans = Int32Array.from(danIds);
  sim.resetRates();
  sim.inject(dans, new Float32Array(dans.length).fill(DAN_DRIVE_MV_PER_MS));
  sim.step(DAN_DRIVE_MS);
  sim.clearInput();
  // the DAN has to have fired; valence alone is not enough
  const danFired = compartments.map((c, ci) => {
    if (!gated[ci] || c.danIds.length === 0) return false;
    const r = sim.rates(Int32Array.from(c.danIds));
    return r.reduce((a, b) => a + b, 0) / r.length > 0;
  });

  const { edgeIdx, src, compartment } = pack.plastic;
  let changed = 0;
  for (let i = 0; i < edgeIdx.length; i++) {
    const c = compartment[i]!;
    if (!danFired[c]) continue;
    const base = pack.weight[edgeIdx[i]!]!;
    const pre = kcRates[src[i]!]!;
    const floor = -Math.min(maxDelta ?? Math.abs(base), Math.abs(base));
    const next = Math.max(floor, s.delta[i]! - eta * (pre / 100) * Math.abs(base));
    if (next !== s.delta[i]) {
      s.delta[i] = next;
      changed++;
    }
  }
  return changed;
}
