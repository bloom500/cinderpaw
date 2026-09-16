/**
 * CinderBrain emotion layer, test E2 (bench-results/brain/emotion/E2-PREREGISTRATION.md): does
 * the connectome turn a history of agent outcomes into a response that the best simple integrator
 * of that history does not reproduce? Reward drives PAM, punishment drives PPL1; the verdict reads
 * only MBONs and the DAN family that was not driven.
 *
 * bun run src/brain-substrate/bench/e2-history.ts --stage g0|arm|analyze --pack <dir> --annotations <tsv> --out <dir> [--arm K|PR|P|PR-SHUFFLED]
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mulberry32 } from "../../memory/fractal/prng.ts";
import { loadPack } from "../pack/load.ts";
import type { BrainPack } from "../pack/types.ts";
import { LifSim } from "../sim/lif.ts";
import { signPreservingTargetShuffle } from "./e1-emotion.ts";
import { sampleWithoutReplacement } from "./stages.ts";

// Preregistered; never tuned after a number exists.
export const WINDOW_MS = 300, PULSE_MS = 100, DRIVE = 2, KC_FRACTION = 0.05;
export const TAU_DA_S = 120, TAU_REC_S = 600, PROBE_GAP_S = 30;
const GAP_MIN_S = 5, GAP_MAX_S = 600, HISTORY = 8;
const TAUS_B1 = [10, 30, 100, 300, 1000, 3600], LAMBDAS_B2 = [0.01, 0.1, 1, 10, 100];

export type Ctx = "A" | "B" | "C" | "D" | "A'";
export interface Ev { v: "R" | "P"; mag: number; ctx: Ctx; gap: number }
export interface Seq { id: string; events: Ev[] }
export interface Rec { m: number; a: number; danOther: number; ht: number; brain: number; mbonAll100: boolean; maxDelta: number; wallMs: number; rss: number }
const BASE: Ctx[] = ["A", "B", "C", "D"];

export function makeSequences(n: number, len: number, seed: number, prefix: string): Seq[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, (_, s) => ({
    id: `${prefix}${s}`,
    events: Array.from({ length: len }, () => ({
      v: rand() < 0.5 ? "R" : "P",
      mag: rand() < 0.5 ? 0.5 : 1,
      ctx: BASE[Math.floor(rand() * 4)]!,
      gap: GAP_MIN_S * Math.pow(GAP_MAX_S / GAP_MIN_S, rand()),
    }) as Ev),
  }));
}

/** A..D disjoint, 5% of KCs each; A' = half of A plus the rest from KCs outside A..D. */
export function makeContexts(kcs: readonly number[], seed: number): Record<Ctx, Int32Array> {
  const size = Math.round(KC_FRACTION * kcs.length), half = Math.floor(size / 2);
  const pick = sampleWithoutReplacement(kcs, 4 * size + (size - half), mulberry32(seed));
  const set = (i: number) => Int32Array.from(pick.slice(i * size, (i + 1) * size));
  return { A: set(0), B: set(1), C: set(2), D: set(3), "A'": Int32Array.from([...pick.slice(0, half), ...pick.slice(4 * size)]) };
}

export function jaccard(a: Int32Array, b: Int32Array): number {
  const s = new Set(a); let inter = 0;
  b.forEach((x) => { if (s.has(x)) inter++; });
  return inter / (a.length + b.length - inter);
}

export function probes(): Seq[] {
  const rep = (v: "R" | "P", n: number, ctx: Ctx = "A"): Ev[] => Array.from({ length: n }, () => ({ v, mag: 1, ctx, gap: PROBE_GAP_S }));
  const ramp = mulberry32(5001);
  const h5 = Array.from({ length: 40 }, (_, i): Ev => ({ v: ramp() < 1 - Math.abs((2 * i) / 39 - 1) ? "R" : "P", mag: 1, ctx: "A", gap: PROBE_GAP_S }));
  const seqs: [string, Ev[]][] = [
    ["freshR_A", rep("R", 1)], ["freshP_A", rep("P", 1)], ["freshR_A'", rep("R", 1, "A'")], ["freshR_B", rep("R", 1, "B")],
    ["H1_afterP", [...rep("P", 4), ...rep("R", 1)]], ["H1_afterR", rep("R", 5)],
    ["H2_PthenR", [...rep("P", 4), ...rep("R", 20)]], ["H2_RthenP", [...rep("R", 4), ...rep("P", 20)]],
    ["H3_RR", rep("R", 2)], ["H3_RP", [...rep("R", 1), ...rep("P", 1)]], ["H3_PR", [...rep("P", 1), ...rep("R", 1)]], ["H3_PP", rep("P", 2)],
    ["H4_A'", [...rep("P", 4), ...rep("R", 1, "A'")]], ["H4_B", [...rep("P", 4), ...rep("R", 1, "B")]],
    ["H5", h5], ["READ_R", rep("R", 6)], ["READ_P", rep("P", 6)],
  ];
  return seqs.map(([id, events]) => ({ id, events }));
}

// ---------------------------------------------------------------- simulation

interface Pops { pam: Int32Array; ppl1: Int32Array; approach: Int32Array; avoid: Int32Array; mbon: Int32Array; ht: Int32Array }
interface ArmOpts { plastic: boolean; recovery: boolean; driveScale: number; onsetMs: number }

function populations(pack: BrainPack, tsv: string): Pops {
  const { compartments, populations: p } = pack.manifest;
  const mbon = p.mbon!;
  const byValence = (v: string) => Int32Array.from(mbon.filter((_, ci) => compartments[ci]!.mbonValence === v));
  const famOf = (v: string) => Int32Array.from(compartments.find((c) => c.mbonValence === v)!.danIds);
  const lines = readFileSync(tsv, "utf8").split("\n"), h = lines[0]!.replace(/\r$/, "").split("\t");
  const rows = lines.slice(1).map((l) => l.replace(/\r$/, "").split("\t")).filter((f) => f.length === h.length);
  if (rows.length !== pack.manifest.neurons) throw new Error(`annotations have ${rows.length} rows, pack has ${pack.manifest.neurons} neurons`);
  const nt = h.indexOf("known_nt");
  const ht = Int32Array.from(rows.flatMap((f, i) => (f[nt]!.split(/[,;]/).map((s) => s.trim()).includes("serotonin") ? [i] : [])));
  return { pam: famOf("avoidance"), ppl1: famOf("approach"), approach: byValence("approach"), avoid: byValence("avoidance"), mbon: Int32Array.from(mbon), ht };
}

const meanRate = (sim: LifSim, ids: Int32Array) => { const r = sim.rates(ids); let s = 0; for (const x of r) s += x; return s / (r.length || 1); };

/** One sequence from a fresh learned state. Each event runs from rest for WINDOW_MS. */
function runSequence(sim: LifSim, pack: BrainPack, pops: Pops, ctx: Record<Ctx, Int32Array>, arm: ArmOpts, seq: Seq): Rec[] {
  const w = pack.weight.slice();
  sim.setEffectiveWeight(w);
  const { edgeIdx, src, compartment } = pack.plastic;
  const valenceOf = pack.manifest.compartments.map((c) => c.mbonValence);
  const delta = new Float32Array(edgeIdx.length);
  const eta = pack.manifest.plasticity.eta;
  return seq.events.map((ev, i) => {
    const t0 = performance.now();
    if (arm.recovery && i > 0) {
      const f = Math.exp(-ev.gap / TAU_REC_S);
      for (let k = 0; k < delta.length; k++) if (delta[k] !== 0) { delta[k] = delta[k]! * f; w[edgeIdx[k]!] = pack.weight[edgeIdx[k]!]! + delta[k]!; }
    }
    const dans = ev.v === "R" ? pops.pam : pops.ppl1, other = ev.v === "R" ? pops.ppl1 : pops.pam;
    const drive = (ids: Int32Array, mv: number) => sim.inject(ids, new Float32Array(ids.length).fill(mv));
    sim.resetState();
    sim.clearInput();
    drive(ctx[ev.ctx], DRIVE * arm.driveScale);
    if (arm.onsetMs > 0) sim.step(arm.onsetMs);
    drive(dans, DRIVE * ev.mag * arm.driveScale);
    sim.step(PULSE_MS);
    drive(dans, 0);
    sim.step(WINDOW_MS - PULSE_MS - arm.onsetMs);
    sim.clearInput();

    const mbonRates = sim.rates(pops.mbon);
    const rec: Rec = {
      m: meanRate(sim, pops.approach) - meanRate(sim, pops.avoid),
      a: mbonRates.reduce((s, x) => s + x, 0) / mbonRates.length,
      danOther: meanRate(sim, other),
      ht: meanRate(sim, pops.ht),
      brain: sim.totalSpikes() / pack.manifest.neurons / (WINDOW_MS / 1000),
      mbonAll100: mbonRates.every((x) => x > 100),
      maxDelta: 0, wallMs: 0, rss: 0,
    };
    // kc-mbon-depression-v1, gated by whether the driven DANs fired; no second DAN drive.
    if (arm.plastic && meanRate(sim, dans) > 0) {
      const gated = ev.v === "R" ? "avoidance" : "approach";
      const pre = sim.rates(src);
      for (let k = 0; k < edgeIdx.length; k++) {
        if (valenceOf[compartment[k]!] !== gated || pre[k] === 0) continue;
        const base = pack.weight[edgeIdx[k]!]!;
        delta[k] = Math.max(-Math.abs(base), delta[k]! - eta * (pre[k]! / 100) * Math.abs(base));
        w[edgeIdx[k]!] = base + delta[k]!;
      }
    }
    let md = 0;
    for (const d of delta) if (-d > md) md = -d;
    rec.maxDelta = md;
    rec.wallMs = performance.now() - t0;
    rec.rss = process.memoryUsage().rss;
    return rec;
  });
}

// ---------------------------------------------------------------- baselines

/** Context as its KC Jaccard with A..D: one-hot for A..D, graded for A'. */
const ctxVec = (c: Ctx, J: Record<string, number>) => BASE.map((b) => J[`${c}|${b}`]!);

/** 16 numbers: valence x magnitude x context. */
export function eventCode(ev: Ev, J: Record<string, number>): number[] {
  const out = new Array(16).fill(0), slot = ((ev.v === "R" ? 0 : 1) * 2 + (ev.mag === 1 ? 1 : 0)) * 4;
  ctxVec(ev.ctx, J).forEach((x, c) => { out[slot + c] = x; });
  return out;
}

export type Model = "B0" | "B1" | "B2";

/** Feature rows for every event of a sequence. */
export function features(seq: Seq, model: Model, tau: number, J: Record<string, number>): number[][] {
  const t: number[] = [];
  seq.events.forEach((ev, i) => t.push(i === 0 ? 0 : t[i - 1]! + ev.gap));
  return seq.events.map((ev, j) => {
    const code = eventCode(ev, J), row = [1, ...code];
    if (model === "B0") return row;
    const tr = [0, 0, 0, 0];
    for (let k = 0; k < j; k++) {
      const e = seq.events[k]!, d = Math.exp(-(t[j]! - t[k]!) / tau), vi = e.v === "R" ? 0 : 1;
      tr[vi] = tr[vi]! + e.mag * d;
      tr[2 + vi] = tr[2 + vi]! + e.mag * d * J[`${e.ctx}|${ev.ctx}`]!;
    }
    row.push(...tr);
    if (model === "B1") return row;
    const hist: number[] = [];
    for (let l = 1; l <= HISTORY; l++) hist.push(...(j - l >= 0 ? eventCode(seq.events[j - l]!, J) : new Array(16).fill(0)));
    for (let l = 1; l <= HISTORY; l++) hist.push(j - l + 1 >= 1 ? Math.log10(1 + seq.events[j - l + 1]!.gap) : 0);
    const rest = [...tr, ...hist];
    row.push(...hist);
    for (const c of code) for (const x of rest) row.push(c * x);
    return row;
  });
}

/** Ridge with an unpenalised intercept (column 0), by Cholesky on the normal equations. */
export function ridgeFromGram(G: Float64Array, b: Float64Array, p: number, lambda: number): Float64Array {
  const A = G.slice();
  for (let i = 1; i < p; i++) A[i * p + i] = A[i * p + i]! + lambda;
  A[0] = A[0]! + 1e-9;
  for (let j = 0; j < p; j++) {
    let s = A[j * p + j]!;
    for (let k = 0; k < j; k++) s -= A[j * p + k]! ** 2;
    const d = Math.sqrt(Math.max(s, 1e-12));
    A[j * p + j] = d;
    for (let i = j + 1; i < p; i++) {
      let x = A[i * p + j]!;
      for (let k = 0; k < j; k++) x -= A[i * p + k]! * A[j * p + k]!;
      A[i * p + j] = x / d;
    }
  }
  const y = new Float64Array(p), beta = new Float64Array(p);
  for (let i = 0; i < p; i++) { let s = b[i]!; for (let k = 0; k < i; k++) s -= A[i * p + k]! * y[k]!; y[i] = s / A[i * p + i]!; }
  for (let i = p - 1; i >= 0; i--) { let s = y[i]!; for (let k = i + 1; k < p; k++) s -= A[k * p + i]! * beta[k]!; beta[i] = s / A[i * p + i]!; }
  return beta;
}

function gram(X: number[][], y: number[]): { G: Float64Array; b: Float64Array } {
  const p = X[0]!.length, G = new Float64Array(p * p), b = new Float64Array(p);
  X.forEach((row, r) => {
    const nz: number[] = [];
    row.forEach((x, i) => { if (x !== 0) nz.push(i); });
    for (const i of nz) { b[i] = b[i]! + row[i]! * y[r]!; for (const k of nz) G[i * p + k] = G[i * p + k]! + row[i]! * row[k]!; }
  });
  return { G, b };
}

const predict = (X: number[][], beta: Float64Array) => X.map((row) => row.reduce((s, x, i) => s + x * beta[i]!, 0));

export function r2(y: number[], yhat: number[]): number {
  const mu = y.reduce((s, x) => s + x, 0) / y.length;
  const ssTot = y.reduce((s, x) => s + (x - mu) ** 2, 0), ssRes = y.reduce((s, x, i) => s + (x - yhat[i]!) ** 2, 0);
  if (ssTot <= 1e-12) return ssRes <= 1e-12 ? 1 : 0;
  return 1 - ssRes / ssTot;
}

interface Fitted { model: Model; tau: number; lambda: number; cvR2: number; beta: Float64Array }

/** Fits one model family, hyperparameters by 5-fold CV over training sequences (pooled held-out R^2). */
function fitModel(model: Model, train: Seq[], y: number[][], J: Record<string, number>, tauFixed?: number): Fitted {
  const taus = model === "B0" ? [1] : model === "B1" ? TAUS_B1 : [tauFixed!];
  const lambdas = model === "B2" ? LAMBDAS_B2 : [1e-6];
  let best: Fitted | undefined;
  for (const tau of taus) {
    const Xs = train.map((s) => features(s, model, tau, J));
    const p = Xs[0]![0]!.length;
    const folds = [0, 1, 2, 3, 4].map((f) => gram(Xs.filter((_, i) => i % 5 === f).flat(), y.filter((_, i) => i % 5 === f).flat()));
    const total = { G: new Float64Array(p * p), b: new Float64Array(p) };
    for (const f of folds) { f.G.forEach((x, i) => { total.G[i] = total.G[i]! + x; }); f.b.forEach((x, i) => { total.b[i] = total.b[i]! + x; }); }
    for (const lambda of lambdas) {
      const ys: number[] = [], ps: number[] = [];
      folds.forEach((f, fi) => {
        const beta = ridgeFromGram(total.G.map((x, i) => x - f.G[i]!), total.b.map((x, i) => x - f.b[i]!), p, lambda);
        const idx = train.map((_, i) => i).filter((i) => i % 5 === fi);
        ys.push(...idx.flatMap((i) => y[i]!));
        ps.push(...idx.flatMap((i) => predict(Xs[i]!, beta)));
      });
      const cvR2 = r2(ys, ps);
      if (!best || cvR2 > best.cvR2) best = { model, tau, lambda, cvR2, beta: ridgeFromGram(total.G, total.b, p, lambda) };
    }
  }
  return best!;
}

// ---------------------------------------------------------------- analysis helpers

/** Events until m is back within 10% of the fresh value, counted from the first event after the 4-event history; 21 = not within 20. */
export function recoveryCount(ms: number[], fresh: number): number {
  for (let k = 4; k < ms.length; k++) if (Math.abs(ms[k]! - fresh) <= 0.1 * Math.abs(fresh)) return k - 3;
  return 21;
}

export function pearson(a: number[], b: number[]): number {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i]! - ma) * (b[i]! - mb); saa += (a[i]! - ma) ** 2; sbb += (b[i]! - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
}

type ProbeM = (id: string) => number[];

/** H1..H5 on one series source; `base` is the same computation on the baseline's predictions. */
function effects(real: ProbeM, base: ProbeM) {
  const Y0 = Math.abs(real("freshR_A")[0]!), q = (ok: boolean, detail: object) => ({ pass: ok, ...detail });
  const c = (s: ProbeM) => s("H1_afterP")[4]! - s("H1_afterR")[4]!;
  const H1 = q(Y0 > 0 && Math.abs(c(real)) >= 0.25 * Y0 && Math.abs(c(real) - c(base)) >= 0.25 * Y0, { Y0, contrast: c(real), baseline: c(base) });

  const ratio = (s: ProbeM) => recoveryCount(s("H2_PthenR"), s("freshR_A")[0]!) / recoveryCount(s("H2_RthenP"), s("freshP_A")[0]!);
  const far = (x: number) => x >= 1.5 || x <= 1 / 1.5;
  const H2 = q(far(ratio(real)) && far(ratio(real) / ratio(base)), { ratio: ratio(real), baseline: ratio(base) });

  const inter = (s: ProbeM) => s("H3_RR")[1]! - s("H3_RP")[1]! - s("H3_PR")[1]! + s("H3_PP")[1]!;
  const scale = ["H3_RR", "H3_RP", "H3_PR", "H3_PP"].reduce((t, id) => t + Math.abs(real(id)[1]!), 0) / 4;
  const H3 = q(scale > 0 && Math.abs(inter(real)) >= 0.2 * scale && Math.abs(inter(real) - inter(base)) >= 0.2 * scale, { interaction: inter(real), baseline: inter(base), scale });

  const gen = (s: ProbeM) => s("H4_A'")[4]! - s("H4_B")[4]!;
  const shiftA = Math.abs(real("H4_A'")[4]! - real("freshR_A'")[0]!), shiftB = Math.abs(real("H4_B")[4]! - real("freshR_B")[0]!);
  const H4 = q(Y0 > 0 && Math.abs(gen(real)) >= 0.25 * Y0 && shiftA > shiftB && Math.abs(gen(real) - gen(base)) >= 0.25 * Y0, { difference: gen(real), baseline: gen(base), shiftA, shiftB });

  const leg = (s: ProbeM, from: number, to: number) => { const xs = s("H5").slice(from, to + 1); return xs.reduce((t, x) => t + x, 0) / xs.length; };
  const hyst = (s: ProbeM) => leg(s, 8, 11) - leg(s, 28, 31);
  const range = Math.max(...real("H5")) - Math.min(...real("H5"));
  const H5 = q(range > 0 && Math.abs(hyst(real)) >= 0.2 * range && Math.abs(hyst(real) - hyst(base)) >= 0.2 * range, { upMinusDown: hyst(real), baseline: hyst(base), range });
  return { H1, H2, H3, H4, H5, passed: [H1, H2, H3, H4, H5].filter((h) => h.pass).length };
}

/** K state: k_e = k_(e-1) * exp(-gap / tau_DA) + m_e. */
const kinetics = (seq: Seq, ms: number[]) => { let k = 0; return ms.map((m, i) => (k = (i === 0 ? 0 : k * Math.exp(-seq.events[i]!.gap / TAU_DA_S)) + m)); };

// ---------------------------------------------------------------- stages

const ARMS: Record<string, ArmOpts & { shuffled: boolean }> = {
  K: { plastic: false, recovery: false, driveScale: 1, onsetMs: 0, shuffled: false },
  PR: { plastic: true, recovery: true, driveScale: 1, onsetMs: 0, shuffled: false },
  P: { plastic: true, recovery: false, driveScale: 1, onsetMs: 0, shuffled: false },
  "PR-SHUFFLED": { plastic: true, recovery: true, driveScale: 1, onsetMs: 0, shuffled: true },
};

if (import.meta.main) {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const stage = arg("stage")!, out = resolve(arg("out")!);
  mkdirSync(out, { recursive: true });
  const train = makeSequences(120, 30, 3001, "train"), test = makeSequences(60, 30, 4001, "test"), probeSeqs = probes();
  const log = (s: string) => process.stderr.write(`${new Date().toISOString()} ${s}\n`);

  if (stage === "analyze") {
    const load = (a: string) => JSON.parse(readFileSync(join(out, `arm-${a}.json`), "utf8")) as {
      J: Record<string, number>; train: Rec[][]; test: Rec[][]; probes: Record<string, Rec[]>; testPert?: Rec[][];
    };
    const report: Record<string, unknown> = {};
    const analyzeArm = (name: string) => {
      const d = load(name), J = d.J, ym = (rs: Rec[][]) => rs.map((s) => s.map((r) => r.m));
      const b0 = fitModel("B0", train, ym(d.train), J), b1 = fitModel("B1", train, ym(d.train), J);
      const b2 = fitModel("B2", train, ym(d.train), J, b1.tau);
      const best = [b0, b1, b2].reduce((x, y) => (y.cvR2 > x.cvR2 ? y : x));
      const testR2 = (f: Fitted) => r2(ym(d.test).flat(), test.flatMap((s) => predict(features(s, f.model, f.tau, J), f.beta)));
      const realP: ProbeM = (id) => d.probes[id]!.map((r) => r.m);
      const baseP: ProbeM = (id) => predict(features(probeSeqs.find((s) => s.id === id)!, best.model, best.tau, J), best.beta);
      const fx = effects(realP, baseP);
      const fits = Object.fromEntries([b0, b1, b2].map((f) => [f.model, { tau: f.tau, lambda: f.lambda, cvR2: f.cvR2, testR2: testR2(f) }]));
      log(`${name}: best ${best.model} test R2 ${testR2(best).toFixed(3)}; B0 ${fits.B0!.testR2.toFixed(3)}; effects passed ${fx.passed}`);
      return { d, best, bestTestR2: testR2(best), fits, fx };
    };

    const K = analyzeArm("K"), PR = analyzeArm("PR"), P = analyzeArm("P"), SH = analyzeArm("PR-SHUFFLED");
    const V0 = K.fits.B0!.testR2 >= 0.95;
    const resid = (rs: Rec[][]) => rs.flatMap((s, i) => { const p = predict(features(test[i]!, PR.best.model, PR.best.tau, PR.d.J), PR.best.beta); return s.map((r, j) => r.m - p[j]!); });
    const V2corr = pearson(resid(PR.d.test), resid(PR.d.testPert!));
    const V4 = [...PR.d.train, ...PR.d.test].every((s) => s.every((r) => r.brain <= Math.max(3 * s[0]!.brain, 0.1) && !r.mbonAll100));
    const V1 = PR.bestTestR2 < 0.8, V2 = V2corr >= 0.7, V3 = PR.fx.passed >= 2;
    const transforms = V0 && V1 && V2 && V3 && V4;

    const within2 = (x: number, y: number) => (x === 0 && y === 0) || (x > 0 && y > 0 && x / y <= 2 && y / x <= 2);
    const informative = ["freshR_A", "freshP_A"].every((id) => (["brain", "a", "danOther"] as const).every((k) => within2(SH.d.probes[id]![0]![k], PR.d.probes[id]![0]![k])));
    const hs = ["H1", "H2", "H3", "H4", "H5"] as const;
    const shuffleFailsOne = hs.some((h) => PR.fx[h].pass && !SH.fx[h].pass) || SH.bestTestR2 >= 0.8;
    const specific = transforms && informative && shuffleFailsOne;

    const persistence = PR.d.test.every((s, i) => {
      const peak = Math.max(...s.map((r) => r.maxDelta)), k = kinetics(test[i]!, s.map((r) => r.m)), kPeak = Math.max(...k.map(Math.abs));
      return s.at(-1)!.maxDelta * Math.exp(-1800 / TAU_REC_S) <= 0.1 * peak && Math.abs(k.at(-1)! * Math.exp(-1800 / TAU_DA_S)) <= 0.1 * kPeak;
    });
    const kTrain = PR.d.train.flatMap((s, i) => kinetics(train[i]!, s.map((r) => r.m))).sort((a, b) => a - b);
    const cuts = [0.2, 0.4, 0.6, 0.8].map((f) => kTrain[Math.floor(f * (kTrain.length - 1))]!);
    const mood = (k: number) => cuts.filter((c) => k > c).length;
    const probeSeq = (id: string) => probeSeqs.find((s) => s.id === id)!;
    const finalMood = (id: string) => mood(kinetics(probeSeq(id), PR.d.probes[id]!.map((r) => r.m)).at(-1)!);
    let changes = 0, transitions = 0;
    PR.d.test.forEach((s, i) => { const ms = kinetics(test[i]!, s.map((r) => r.m)).map(mood); for (let j = 1; j < ms.length; j++) { transitions++; if (ms[j] !== ms[j - 1]) changes++; } });
    const readable = Math.abs(finalMood("READ_R") - finalMood("READ_P")) >= 2 && changes / transitions <= 1 / 3;

    const walls = [...PR.d.train, ...PR.d.test].flat().map((r) => r.wallMs).sort((a, b) => a - b);
    const p95 = walls[Math.floor(0.95 * (walls.length - 1))]!, rss = Math.max(...[...PR.d.train, ...PR.d.test].flat().map((r) => r.rss));
    const cost = p95 <= 1000 && rss <= 1024 ** 3;

    const verdict = { V0, V1, V2, V3, V4, TRANSFORMS: transforms, shuffleInformative: informative, CONNECTOME_SPECIFIC: specific, CONTROLLED_PERSISTENCE: persistence, READABLE: readable, COST: cost };
    const arm = (a: ReturnType<typeof analyzeArm>) => ({ bestModel: a.best.model, bestTestR2: a.bestTestR2, fits: a.fits, effects: a.fx });
    Object.assign(report, {
      verdict, V2residualCorrelation: V2corr, moodCuts: cuts, moodFlicker: changes / transitions, moodReadR: finalMood("READ_R"), moodReadP: finalMood("READ_P"),
      costP95Ms: p95, costPeakRssMb: rss / 1024 ** 2,
      arms: { K: arm(K), PR: arm(PR), "P-as-built": arm(P), "PR-SHUFFLED": arm(SH) },
      serotoninExploratory: Object.fromEntries(["freshR_A", "freshP_A"].map((id) => [id, { real: PR.d.probes[id]![0]!.ht, shuffled: SH.d.probes[id]![0]!.ht }])),
    });
    writeFileSync(join(out, "e2-verdict.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(verdict));
  } else {
    const pack0 = loadPack(arg("pack")!), pops = populations(pack0, arg("annotations")!);
    const kcs = pack0.manifest.populations.kc!;
    const ctx = makeContexts(kcs, 2001);
    const J: Record<string, number> = {};
    for (const a of [...BASE, "A'"] as Ctx[]) for (const b of [...BASE, "A'"] as Ctx[]) J[`${a}|${b}`] = jaccard(ctx[a], ctx[b]);

    if (stage === "g0") {
      const sim = new LifSim(pack0);
      const counts = { pam: pops.pam.length, ppl1: pops.ppl1.length, mbon: pops.mbon.length, approach: pops.approach.length, avoid: pops.avoid.length, kc: kcs.length, contextSize: ctx.A.length, aPrime: ctx["A'"].length, jaccardAprimeA: J["A'|A"], ht: pops.ht.length };
      const fired = (v: "R" | "P") => {
        const s: Seq = { id: `g0${v}`, events: [{ v, mag: 1, ctx: "A", gap: PROBE_GAP_S }] };
        const r = runSequence(sim, pack0, pops, ctx, ARMS.PR!, s)[0]!;
        return { rec: r, mbonFiredFraction: sim.rates(pops.mbon).filter((x) => x > 0).length / pops.mbon.length };
      };
      const R = fired("R"), P = fired("P");
      const walls = runSequence(sim, pack0, pops, ctx, ARMS.PR!, train[0]!).map((r) => r.wallMs);
      const meanWall = walls.reduce((s, x) => s + x, 0) / walls.length;
      const probeEvents = probeSeqs.reduce((s, q) => s + q.events.length, 0), base = 5400 + probeEvents;
      const events = { K: base, PR: base + 1800, P: base, "PR-SHUFFLED": base };
      const hours = Object.fromEntries(Object.entries(events).map(([k, n]) => [k, (n * meanWall) / 3.6e6]));
      const pass = R.mbonFiredFraction >= 0.1 && P.mbonFiredFraction >= 0.1 && (Math.sign(R.rec.m) !== Math.sign(P.rec.m) || Math.abs(R.rec.m - P.rec.m) >= 0.1);
      const sequentialHours = Object.values(hours).reduce((s, x) => s + x, 0);
      const g0 = { pass, counts, reward: R, punishment: P, meanWallMsPerEvent: meanWall, estimatedHours: hours, sequentialHours, fitsOneNight: Math.max(...Object.values(hours)) <= 10 };
      writeFileSync(join(out, "g0.json"), JSON.stringify(g0, null, 2));
      console.log(JSON.stringify({ pass, counts, mbonFired: [R.mbonFiredFraction, P.mbonFiredFraction], m: [R.rec.m, P.rec.m], meanWall, sequentialHours }));
      process.exit(pass ? 0 : 2);
    }

    const name = arg("arm")!, opts = ARMS[name];
    if (!opts) throw new Error(`unknown arm ${name}`);
    const pack = opts.shuffled ? signPreservingTargetShuffle(pack0, 1001, pack0.plastic.edgeIdx) : pack0;
    const sim = new LifSim(pack);
    // Every sequence is independent (fresh deltas, resetState per event), so a finished one can be
    // replayed from disk instead of resimulated, by this process or by any other. That makes the
    // run both resumable after a kill and splittable across cores: --shard k/N computes only the
    // sequences with i % N === k and writes its own file; the run that finds every index cached
    // writes the arm's result. This PC has 16 cores and one arm uses one, so N is free speed.
    const [shardK, shardN] = (arg("shard") ?? "0/1").split("/").map(Number) as [number, number];
    const shardFile = (label: string) => join(out, `arm-${name}-${label}.s${shardK}-${shardN}.jsonl`);
    const cached = (label: string): Map<number, Rec[]> => {
      const rows = new Map<number, Rec[]>();
      const prefix = `arm-${name}-${label}`;
      for (const f of readdirSync(out).filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"))) {
        let seq = 0; // the pre-shard format is a bare Rec[] per line, in order
        for (const line of readFileSync(join(out, f), "utf8").split("\n")) {
          if (!line) continue;
          let parsed: unknown;
          try { parsed = JSON.parse(line); } catch { break; } // truncated tail from a kill
          if (Array.isArray(parsed)) rows.set(seq++, parsed as Rec[]);
          else { const { i, r } = parsed as { i: number; r: Rec[] }; rows.set(i, r); }
        }
      }
      return rows;
    };
    let missing = 0;
    const runSet = (seqs: Seq[], label: string, o: ArmOpts, c = ctx) => {
      const p = shardFile(label), done = cached(label);
      if (done.size) log(`${name} ${label} ${done.size}/${seqs.length} already on disk`);
      let ran = 0; // count what THIS process computed: i % 10 is only ever 9 on an odd shard
      return seqs.map((s, i) => {
        const hit = done.get(i);
        if (hit) return hit;
        if (i % shardN !== shardK) { missing++; return [] as Rec[]; }
        const r = runSequence(sim, pack, pops, c, o, s);
        appendFileSync(p, `${JSON.stringify({ i, r })}\n`);
        if (++ran % 10 === 0 || i === seqs.length - 1) log(`${name} ${label} shard ${shardK}/${shardN} ran ${ran}, at ${i + 1}/${seqs.length}`);
        return r;
      });
    };
    const result: Record<string, unknown> = { J, arm: name };
    const probeFile = join(out, `arm-${name}-probes.json`);
    if (existsSync(probeFile)) result.probes = JSON.parse(readFileSync(probeFile, "utf8")) as Record<string, Rec[]>;
    else if (shardK === 0) { // one writer, so shards never race on this file
      result.probes = Object.fromEntries(probeSeqs.map((s) => [s.id, runSequence(sim, pack, pops, ctx, opts, s)]));
      writeFileSync(probeFile, JSON.stringify(result.probes));
    } else { result.probes = {}; missing++; }
    log(`${name} probes done`);
    result.train = runSet(train, "train", opts);
    result.test = runSet(test, "test", opts);
    if (name === "PR") {
      const ctxPert = makeContexts(kcs, 2002);
      result.testPert = runSet(test, "testPert", { ...opts, driveScale: 1.05, onsetMs: 2 }, { ...ctxPert, "A'": ctx["A'"] });
    }
    if (missing > 0) { log(`${name} shard ${shardK}/${shardN} done; ${missing} sequences belong to other shards, no result written`); process.exit(0); }
    writeFileSync(join(out, `arm-${name}.json`), JSON.stringify(result));
    log(`${name} written`);
  }
}
