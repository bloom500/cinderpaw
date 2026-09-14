/**
 * How an embedding becomes a sensory input pattern (spec section 5.3): a fixed
 * random projection picks which sensory neurons a vector excites. The brain
 * never sees text; it sees which 5% of its sensory neurons are on.
 */
import { mulberry32 } from "../../memory/fractal/prng.ts";
import type { BrainPack } from "../pack/types.ts";
import type { LifSim } from "../sim/lif.ts";

export const PATTERN_DRIVE_MV_PER_MS = 2;
export const READOUT_MS = 50;

/** dims x targets, N(0,1) by Box-Muller, deterministic under the seed. */
export function makeProjection(dims: number, targets: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const out = new Float32Array(dims * targets);
  for (let i = 0; i < out.length; i++) {
    const u = 1 - rand(), v = rand();
    out[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  return out;
}

/** proj^T * vec; the top topFrac of targets get 2 mV/ms, the rest 0. */
export function embeddingToCurrent(vec: Float32Array, proj: Float32Array, targets: number, topFrac = 0.05): Float32Array {
  const dims = vec.length;
  if (proj.length !== dims * targets) throw new Error(`projection is ${proj.length} long, expected ${dims} x ${targets}`);
  const score = new Float32Array(targets);
  for (let d = 0; d < dims; d++) {
    const x = vec[d]!;
    if (x === 0) continue;
    const row = d * targets;
    for (let t = 0; t < targets; t++) score[t] = score[t]! + proj[row + t]! * x;
  }
  const k = Math.max(1, Math.ceil(targets * topFrac));
  const top = Array.from(score.keys()).sort((a, b) => score[b]! - score[a]!).slice(0, k);
  const current = new Float32Array(targets);
  for (const t of top) current[t] = PATTERN_DRIVE_MV_PER_MS;
  return current;
}

/** From rest, hold the pattern on the sensory population for `ms`, and read mbon and kc rates. */
export function readoutFromRest(
  pack: BrainPack,
  sim: LifSim,
  current: Float32Array,
  ms = READOUT_MS,
): { mbon: Float32Array; kc: Float32Array } {
  const sensory = pack.populations.sensory!;
  sim.resetState();
  sim.inject(sensory, current);
  sim.step(ms);
  sim.clearInput();
  return { mbon: sim.rates(pack.populations.mbon!), kc: sim.rates(pack.populations.kc!) };
}
