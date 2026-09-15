/**
 * AlSim: LifSim plus the two antennal-lobe inhibition mechanisms of Variant 1 step G4
 * (bench-results/brain/VALIDATION-LADDER.md, 2026-09-15 21:45). LifSim is unchanged;
 * with no patchy cells and no presynaptic inhibition AlSim is LifSim.
 *
 * 1. Patchy local neurons never spike. Each has one graded compartment per glomerulus it
 *    has synapses in, with the Shiu 2024 membrane and synapse kernel and no threshold.
 *    Input edges are split across compartments by that edge's synapses per glomerulus;
 *    each compartment releases at the expected rate (1000 / refractoryMs) *
 *    clamp((v - vRest) / (vThresh - vRest), 0, 1) onto the cell's targets in the SAME
 *    glomerulus only.
 * 2. Inhibitory local-neuron -> ORN edges act presynaptically: they drive gPre of the ORN,
 *    and p (tau_p dp/dt = -p + 1 / (1 + |gPre| / gHalf)) scales every edge the ORN sends.
 */
import type { BrainPack } from "../pack/types.ts";
import { LifSim } from "./lif.ts";

export interface AlSynapseRow { pre: number; post: number; glomerulus: string; synapses: number }

export interface AlSimOptions {
  effectiveWeight?: Float32Array;
  /** Neuron indices simulated as graded, compartmentalised cells. */
  patchy?: Iterable<number>;
  /** Neuron indices of ORNs (targets of presynaptic inhibition). */
  orns?: Iterable<number>;
  /** Neuron indices of antennal-lobe local neurons (sources of presynaptic inhibition). */
  localNeurons?: Iterable<number>;
  /** Local-neuron synapses by glomerulus, from bench/al-synapses.ts. */
  synapses?: AlSynapseRow[];
  /** mV; presynaptic inhibition is off when absent. */
  gHalf?: number;
  tauPMs?: number;
}

type Split = { comp: Int32Array; frac: Float32Array };

export class AlSim extends LifSim {
  private readonly patchy: Uint8Array;
  private readonly isOrn: Uint8Array;
  private readonly presynEdge: Uint8Array;
  private readonly gHalf: number | null;
  private readonly tauP: number;
  // compartments
  readonly compCell: Int32Array;
  readonly compGlom: string[];
  private readonly vC: Float32Array;
  private readonly gC: Float32Array;
  private readonly depolSum: Float64Array;
  private depolSteps = 0;
  /** edge index -> compartments of its patchy target */
  private readonly inSplit = new Map<number, Split>();
  /** compartment -> (target, weight share) pairs */
  private readonly outTargets: Int32Array[];
  private readonly outWeights: Float32Array[];
  // presynaptic
  private readonly gPre: Float32Array;
  readonly p: Float32Array;
  private readonly ornList: Int32Array;

  constructor(pack: BrainPack, opts: AlSimOptions = {}) {
    super(pack, opts.effectiveWeight ? { effectiveWeight: opts.effectiveWeight } : {});
    const n = pack.manifest.neurons, { rowPtr, colIdx } = pack;
    this.patchy = new Uint8Array(n);
    for (const i of opts.patchy ?? []) this.patchy[i] = 1;
    this.isOrn = new Uint8Array(n);
    for (const i of opts.orns ?? []) this.isOrn[i] = 1;
    this.ornList = Int32Array.from(opts.orns ?? []);
    this.gHalf = opts.gHalf ?? null;
    this.tauP = opts.tauPMs ?? 300;
    this.gPre = new Float32Array(n);
    this.p = new Float32Array(n).fill(1);

    const w = this.wEff;
    this.presynEdge = new Uint8Array(colIdx.length);
    if (this.gHalf !== null) {
      for (const j of opts.localNeurons ?? []) {
        for (let e = rowPtr[j]!; e < rowPtr[j + 1]!; e++) if (this.isOrn[colIdx[e]!] && w[e]! < 0) this.presynEdge[e] = 1;
      }
    }

    // Compartments: one per (patchy cell, glomerulus with any assigned synapse of that cell).
    const byPair = new Map<string, Map<string, number>>(); // "pre,post" -> glomerulus -> synapses
    const cellGlom = new Map<number, Map<string, number>>(); // patchy cell -> glomerulus -> synapses (in + out)
    for (const r of opts.synapses ?? []) {
      if (!this.patchy[r.pre] && !this.patchy[r.post]) continue;
      const k = `${r.pre},${r.post}`;
      const m = byPair.get(k) ?? byPair.set(k, new Map()).get(k)!;
      m.set(r.glomerulus, (m.get(r.glomerulus) ?? 0) + r.synapses);
      for (const c of [r.pre, r.post]) {
        if (!this.patchy[c]) continue;
        const cg = cellGlom.get(c) ?? cellGlom.set(c, new Map()).get(c)!;
        cg.set(r.glomerulus, (cg.get(r.glomerulus) ?? 0) + r.synapses);
      }
    }
    const compOf = new Map<string, number>();
    const cells: number[] = [], gloms: string[] = [];
    for (const [c, gm] of cellGlom) for (const g of gm.keys()) { compOf.set(`${c},${g}`, cells.length); cells.push(c); gloms.push(g); }
    this.compCell = Int32Array.from(cells);
    this.compGlom = gloms;
    const C = cells.length;
    this.vC = new Float32Array(C).fill(pack.manifest.simParams.vRest);
    this.gC = new Float32Array(C);
    this.depolSum = new Float64Array(C);

    // Glomerulus shares of a pair, falling back to the cell's overall shares when the pair has no assigned synapse.
    const shares = (pre: number, post: number, cell: number): [string, number][] => {
      const m = byPair.get(`${pre},${post}`) ?? cellGlom.get(cell);
      if (!m) return [];
      const tot = [...m.values()].reduce((a, b) => a + b, 0);
      return [...m].filter(([g]) => compOf.has(`${cell},${g}`)).map(([g, s]) => [g, s / tot]);
    };

    const outT: number[][] = Array.from({ length: C }, () => []), outW: number[][] = Array.from({ length: C }, () => []);
    for (let src = 0; src < n; src++) {
      for (let e = rowPtr[src]!; e < rowPtr[src + 1]!; e++) {
        const t = colIdx[e]!;
        if (this.patchy[t]) {
          const s = shares(src, t, t);
          this.inSplit.set(e, { comp: Int32Array.from(s.map(([g]) => compOf.get(`${t},${g}`)!)), frac: Float32Array.from(s.map(([, f]) => f)) });
        }
        if (this.patchy[src]) {
          for (const [g, f] of shares(src, t, src)) {
            const ci = compOf.get(`${src},${g}`)!;
            // Patchy -> patchy lands in the target's compartment of the same glomerulus, when it has one.
            const tc = this.patchy[t] ? compOf.get(`${t},${g}`) : undefined;
            if (this.patchy[t] && tc === undefined) continue;
            outT[ci]!.push(this.patchy[t] ? -1 - tc! : t);
            outW[ci]!.push(w[e]! * f);
          }
        }
      }
    }
    this.outTargets = outT.map((a) => Int32Array.from(a));
    this.outWeights = outW.map((a) => Float32Array.from(a));
  }

  override resetState(): void {
    super.resetState();
    this.vC.fill(this.pack.manifest.simParams.vRest);
    this.gC.fill(0);
    this.gPre.fill(0);
    this.p.fill(1);
    this.resetCompartmentStats();
  }

  resetCompartmentStats(): void {
    this.depolSum.fill(0);
    this.depolSteps = 0;
  }

  /** Mean v - vRest per compartment since resetCompartmentStats(). */
  compartmentDepolarisation(): Float64Array {
    return this.depolSum.map((s) => (this.depolSteps ? s / this.depolSteps : 0));
  }

  meanP(neurons: ArrayLike<number>): number {
    let s = 0;
    for (let k = 0; k < neurons.length; k++) s += this.p[neurons[k]!]!;
    return neurons.length ? s / neurons.length : 1;
  }

  protected override deliver(): void {
    const slot = this.pending[this.t % this.ringLen]!;
    if (slot.length === 0) return;
    slot.sort((a, b) => a - b);
    const { rowPtr, colIdx } = this.pack;
    for (const j of slot) {
      const scale = this.isOrn[j] ? this.p[j]! : 1;
      for (let e = rowPtr[j]!; e < rowPtr[j + 1]!; e++) {
        const t = colIdx[e]!, w = this.wEff[e]!;
        if (this.presynEdge[e]) { this.gPre[t] = this.gPre[t]! + w; continue; }
        if (this.patchy[t]) {
          const s = this.inSplit.get(e)!;
          for (let q = 0; q < s.comp.length; q++) this.gC[s.comp[q]!] = this.gC[s.comp[q]!]! + w * scale * s.frac[q]!;
          continue;
        }
        this.onArrival(t, w * scale);
      }
    }
    slot.length = 0;
  }

  protected override stepOnce(): void {
    super.stepOnce();
    const sp = this.pack.manifest.simParams;
    const fMaxPerStep = (1000 / sp.refractoryMs) * (this.dt / 1000);
    const span = sp.vThresh - sp.vRest;
    for (let c = 0; c < this.vC.length; c++) {
      this.gC[c] = this.gC[c]! * this.eS;
      this.vC[c] = sp.vRest + (this.vC[c]! - sp.vRest) * this.eM + this.gC[c]! * (1 - this.eM);
      const d = this.vC[c]! - sp.vRest;
      this.depolSum[c] = this.depolSum[c]! + d;
      const release = Math.min(1, Math.max(0, d / span)) * fMaxPerStep;
      if (release === 0) continue;
      const ts = this.outTargets[c]!, ws = this.outWeights[c]!;
      for (let q = 0; q < ts.length; q++) {
        const t = ts[q]!;
        if (t < 0) this.gC[-1 - t] = this.gC[-1 - t]! + ws[q]! * release;
        else this.onArrival(t, ws[q]! * release);
      }
    }
    this.depolSteps++;
    if (this.gHalf !== null) {
      const k = this.dt / this.tauP;
      for (const o of this.ornList) {
        this.gPre[o] = this.gPre[o]! * this.eS;
        this.p[o] = this.p[o]! + k * (-this.p[o]! + 1 / (1 + Math.abs(this.gPre[o]!) / this.gHalf));
      }
    }
  }
}
