/**
 * DenseLif: the correctness oracle for LifSim. Every neuron is updated every
 * step, O(N) per step with no active set, so nothing can be skipped by
 * mistake. Same dynamics as lif.ts (spec section 3), and the same equations as
 * the reference Brian2 model of Shiu et al. 2024
 * (github.com/philshiu/Drosophila_brain_model, model.py):
 *
 *   dv/dt = (v_0 - v + g) / t_mbr     (unless refractory)
 *   dg/dt = -g / tau                  (unless refractory)
 *   on a presynaptic spike, after the delay:  g += w        (w = sign * synapses * 0.275 mV)
 *   on threshold:  v = v_rst, g = 0, refractory 2.2 ms
 *
 * g is a voltage; one spike through a weight w adds w * tau / t_mbr = w / 4
 * to the membrane integral. The plan's original kernel fed an alpha function
 * into v without the 1 / t_mbr and integrated to 5 w: a 20x gain that made
 * every pack run away (measured 2026-09-14). External input is a held drive in
 * mV per ms, so a sensory neuron at 2 mV/ms fires near the 150 Hz the
 * reference model gives its Poisson-driven neurons.
 *
 * Never run this on FlyWire; it exists so tests/brain-sim.test.ts can prove
 * the sparse simulator equals it to 1e-3 on the fixture circuit.
 */
import type { BrainPack } from "../pack/types.ts";

export class DenseLif {
  readonly pack: BrainPack;
  protected readonly n: number;
  protected readonly dt: number;
  protected readonly eS: number;
  protected readonly eM: number;
  protected readonly refrSteps: number;
  protected readonly delaySteps: number;
  protected readonly ringLen: number;
  protected v: Float32Array;
  protected g: Float32Array;
  protected refr: Int32Array;
  protected iExt: Float32Array;
  protected spikes: Int32Array;
  protected wEff: Float32Array;
  protected pending: number[][];
  protected t = 0;
  protected rateSteps = 0;
  protected spikeTotal = 0;

  constructor(pack: BrainPack, opts: { seed?: number; effectiveWeight?: Float32Array } = {}) {
    // ponytail: seed is accepted for the future noise term; with no noise the sim is deterministic
    void opts.seed;
    this.pack = pack;
    const p = pack.manifest.simParams;
    this.n = pack.manifest.neurons;
    this.dt = p.dtMs;
    this.eS = Math.exp(-this.dt / p.tauS);
    this.eM = Math.exp(-this.dt / p.tauM);
    this.refrSteps = Math.round(p.refractoryMs / this.dt);
    this.delaySteps = Math.round(p.delayMs / this.dt);
    this.ringLen = this.delaySteps + 1;
    this.v = new Float32Array(this.n).fill(p.vRest);
    this.g = new Float32Array(this.n);
    this.refr = new Int32Array(this.n);
    this.iExt = new Float32Array(this.n);
    this.spikes = new Int32Array(this.n);
    this.pending = Array.from({ length: this.ringLen }, () => []);
    this.wEff = pack.weight;
    if (opts.effectiveWeight) this.setEffectiveWeight(opts.effectiveWeight);
  }

  /** External input, mV of depolarisation per ms, held until cleared. */
  inject(neurons: Int32Array, current: Float32Array): void {
    if (neurons.length !== current.length) throw new Error("inject: neurons and current differ in length");
    for (let k = 0; k < neurons.length; k++) this.iExt[neurons[k]!] = current[k]!;
  }

  clearInput(): void {
    this.iExt.fill(0);
  }

  step(ms: number): void {
    const steps = Math.round(ms / this.dt);
    for (let s = 0; s < steps; s++) this.stepOnce();
  }

  /** Spikes per second per neuron since the last resetRates(). */
  rates(neurons: Int32Array): Float32Array {
    const out = new Float32Array(neurons.length);
    if (this.rateSteps === 0) return out;
    const perSec = 1000 / (this.rateSteps * this.dt);
    for (let k = 0; k < neurons.length; k++) out[k] = this.spikes[neurons[k]!]! * perSec;
    return out;
  }

  resetRates(): void {
    this.spikes.fill(0);
    this.rateSteps = 0;
    this.spikeTotal = 0;
  }

  resetState(): void {
    this.v.fill(this.pack.manifest.simParams.vRest);
    this.g.fill(0);
    this.refr.fill(0);
    for (const slot of this.pending) slot.length = 0;
    this.t = 0;
    this.resetRates();
  }

  exportState(neurons: Int32Array): Float32Array {
    const out = new Float32Array(neurons.length);
    for (let k = 0; k < neurons.length; k++) out[k] = this.v[neurons[k]!]!;
    return out;
  }

  importState(neurons: Int32Array, v: Float32Array): void {
    if (neurons.length !== v.length) throw new Error("importState: neurons and v differ in length");
    for (let k = 0; k < neurons.length; k++) this.v[neurons[k]!] = v[k]!;
  }

  /** Plasticity swaps in base + delta; the pack's own weights are never touched. */
  setEffectiveWeight(w: Float32Array): void {
    if (w.length !== this.pack.colIdx.length) {
      throw new Error(`setEffectiveWeight: expected ${this.pack.colIdx.length} weights, got ${w.length}`);
    }
    this.wEff = w;
  }

  /** Spikes since the last resetRates(). */
  totalSpikes(): number {
    return this.spikeTotal;
  }

  /** Spikes due this step land on their targets' synaptic drive. */
  protected deliver(): void {
    const slot = this.pending[this.t % this.ringLen]!;
    if (slot.length === 0) return;
    // Sorted so the sparse sim, which fires in a different neuron order, sums x in the same order.
    slot.sort((a, b) => a - b);
    const { rowPtr, colIdx } = this.pack;
    for (const j of slot) {
      for (let e = rowPtr[j]!; e < rowPtr[j + 1]!; e++) this.onArrival(colIdx[e]!, this.wEff[e]!);
    }
    slot.length = 0;
  }

  protected onArrival(target: number, w: number): void {
    this.g[target] = this.g[target]! + w;
  }

  protected fire(i: number): void {
    this.spikes[i] = this.spikes[i]! + 1;
    this.spikeTotal++;
    this.pending[(this.t + this.delaySteps) % this.ringLen]!.push(i);
  }

  /** One neuron, one dt. Shared with the sparse sim so the two can only differ in who gets updated. */
  protected updateNeuron(i: number): void {
    if (this.refr[i]! > 0) {
      // "unless refractory": v and g are frozen; arrivals still add to g
      this.refr[i]!--;
      return;
    }
    const p = this.pack.manifest.simParams;
    this.g[i] = this.g[i]! * this.eS;
    // exponential Euler on dv/dt = (vRest - v + g) / tauM + iExt, g held over the step
    this.v[i] = p.vRest + (this.v[i]! - p.vRest) * this.eM + (this.g[i]! + this.iExt[i]! * p.tauM) * (1 - this.eM);
    if (this.v[i]! > p.vThresh) {
      this.v[i] = p.vRest;
      this.g[i] = 0;
      this.refr[i] = this.refrSteps;
      this.fire(i);
    }
  }

  protected stepOnce(): void {
    this.deliver();
    for (let i = 0; i < this.n; i++) this.updateNeuron(i);
    this.t++;
    this.rateSteps++;
  }
}
