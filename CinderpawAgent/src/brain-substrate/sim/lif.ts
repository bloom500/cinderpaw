/**
 * LifSim: the production simulator. Same dynamics as DenseLif (it inherits the
 * per-neuron kernel), but only neurons that are doing something are updated:
 * a neuron is active while it is refractory, off rest, has synaptic drive, or
 * has external input. Everything else sits exactly at rest and is skipped.
 * Spike propagation walks only the CSR rows of neurons that fired
 * (spec section 3). tests/brain-sim.test.ts holds this equal to DenseLif.
 */
import type { BrainPack } from "../pack/types.ts";
import { DenseLif } from "./dense-reference.ts";

const V_EPS = 1e-4;
const G_EPS = 1e-6;
const SWEEP_EVERY = 100;

export class LifSim extends DenseLif {
  private active: Int32Array;
  private activeCount = 0;
  private isActive: Uint8Array;

  constructor(pack: BrainPack, opts: { seed?: number; effectiveWeight?: Float32Array } = {}) {
    super(pack, opts);
    this.active = new Int32Array(this.n);
    this.isActive = new Uint8Array(this.n);
  }

  private activate(i: number): void {
    if (this.isActive[i]) return;
    this.isActive[i] = 1;
    this.active[this.activeCount++] = i;
  }

  override inject(neurons: Int32Array, current: Float32Array): void {
    super.inject(neurons, current);
    for (let k = 0; k < neurons.length; k++) if (current[k] !== 0) this.activate(neurons[k]!);
  }

  override importState(neurons: Int32Array, v: Float32Array): void {
    super.importState(neurons, v);
    for (let k = 0; k < neurons.length; k++) this.activate(neurons[k]!);
  }

  override resetState(): void {
    super.resetState();
    this.isActive.fill(0);
    this.activeCount = 0;
  }

  protected override onArrival(target: number, w: number): void {
    super.onArrival(target, w);
    this.activate(target);
  }

  private quiet(i: number): boolean {
    return (
      this.refr[i] === 0 &&
      Math.abs(this.v[i]! - this.pack.manifest.simParams.vRest) <= V_EPS &&
      Math.abs(this.g[i]!) <= G_EPS &&
      this.iExt[i] === 0
    );
  }

  /** Drop quiet neurons from the list and snap them to exact rest, so "inactive" means "at rest". */
  private sweep(): void {
    const vRest = this.pack.manifest.simParams.vRest;
    let keep = 0;
    for (let k = 0; k < this.activeCount; k++) {
      const i = this.active[k]!;
      if (this.quiet(i)) {
        this.isActive[i] = 0;
        this.v[i] = vRest;
        this.g[i] = 0;
      } else {
        this.active[keep++] = i;
      }
    }
    this.activeCount = keep;
  }

  protected override stepOnce(): void {
    this.deliver();
    for (let k = 0; k < this.activeCount; k++) this.updateNeuron(this.active[k]!);
    this.t++;
    this.rateSteps++;
    if (this.t % SWEEP_EVERY === 0) this.sweep();
  }
}
