/**
 * Learned state lives apart from the pack (spec section 4): one delta per
 * plastic edge, parallel to pack.plastic.edgeIdx, never positive, never
 * larger in magnitude than the base weight. The pack's own weights are
 * read-only; effectiveWeight() builds what the simulator runs on.
 */
import type { BrainPack } from "../pack/types.ts";

export interface PlasticState {
  delta: Float32Array;
}

export function newPlasticState(pack: BrainPack): PlasticState {
  return { delta: new Float32Array(pack.plastic.edgeIdx.length) };
}

/** base + delta at the plastic positions; every other edge is the pack's weight. */
export function effectiveWeight(pack: BrainPack, s: PlasticState): Float32Array {
  const w = pack.weight.slice();
  const { edgeIdx } = pack.plastic;
  for (let i = 0; i < edgeIdx.length; i++) w[edgeIdx[i]!] = w[edgeIdx[i]!]! + s.delta[i]!;
  return w;
}
