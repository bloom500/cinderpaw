/**
 * CinderBrain emotion layer, test E1 (bench-results/brain/emotion/PREREGISTRATION.md):
 * do FlyWire's dopamine and serotonin populations show valence, scalability, persistence and
 * generalization when the fly tastes sugar or bitter? Also writes a compact activity movie
 * (frontal brain map, 50 ms frames) for the visual page.
 *
 * bun run src/brain-substrate/bench/e1-emotion.ts --pack <dir> --annotations <tsv> --out <dir>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mulberry32 } from "../../memory/fractal/prng.ts";
import { loadPack } from "../pack/load.ts";
import type { BrainPack } from "../pack/types.ts";
import { LifSim } from "../sim/lif.ts";
import { alnLabel, relabel } from "./labels.ts";
import { sampleWithoutReplacement } from "./stages.ts";

export const BIN_MS = 50;
const PRE_MS = 200, STIM_MS = 200, POST_END_MS = 2000;
const GRID_W = 160, GRID_H = 80;

/** Whole-brain control: targets permuted among edges of the same sign; degrees, signs and weights kept. Edges in `keep` stay put. */
export function signPreservingTargetShuffle(pack: BrainPack, seed: number, keep?: Int32Array): BrainPack {
  const rand = mulberry32(seed), colIdx = Int32Array.from(pack.colIdx);
  const kept = new Uint8Array(colIdx.length);
  keep?.forEach((e) => { kept[e] = 1; });
  for (const positive of [true, false]) {
    const edges: number[] = [];
    for (let e = 0; e < colIdx.length; e++) if (!kept[e] && pack.weight[e]! > 0 === positive) edges.push(e);
    for (let i = edges.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const a = edges[i]!, b = edges[j]!;
      [colIdx[a], colIdx[b]] = [colIdx[b]!, colIdx[a]!];
    }
  }
  return { ...pack, colIdx };
}

type Stim = { neurons: Int32Array; onMs: number };
export interface Trace { pam: number[]; ppl: number[]; ht: number[]; brain: number[] }

/** Runs one trial from rest; returns per-bin population rates, plus per-bin grid activity if asked. */
function trial(sim: LifSim, pops: Record<"pam" | "ppl" | "ht", Int32Array>, all: Int32Array, stims: Stim[], intensity: number, endMs: number, grid?: { cell: Int32Array; frames: number[][] }): Trace {
  sim.resetState();
  const tr: Trace = { pam: [], ppl: [], ht: [], brain: [] };
  const mean = (r: Float32Array) => r.reduce((a, b) => a + b, 0) / (r.length || 1);
  for (let t = -PRE_MS; t < endMs; t += BIN_MS) {
    const active = stims.filter((s) => t >= s.onMs && t < s.onMs + STIM_MS);
    sim.clearInput();
    for (const s of active) sim.inject(s.neurons, new Float32Array(s.neurons.length).fill(intensity));
    sim.resetRates();
    sim.step(BIN_MS);
    tr.pam.push(mean(sim.rates(pops.pam)));
    tr.ppl.push(mean(sim.rates(pops.ppl)));
    tr.ht.push(mean(sim.rates(pops.ht)));
    const r = sim.rates(all);
    tr.brain.push(mean(r));
    if (grid) {
      const counts = new Map<number, number>();
      r.forEach((v, i) => { if (v > 0 && grid.cell[i]! >= 0) counts.set(grid.cell[i]!, (counts.get(grid.cell[i]!) ?? 0) + (v * BIN_MS) / 1000); });
      grid.frames.push([...counts].flatMap(([c, n]) => [c, Math.round(n)]));
    }
  }
  sim.clearInput();
  return tr;
}

const binOf = (ms: number) => Math.round((ms + PRE_MS) / BIN_MS);
/** Mean over [from, to) ms minus the pre-stimulus baseline. */
export const delta = (xs: number[], fromMs: number, toMs: number) => {
  const base = xs.slice(0, binOf(0)).reduce((a, b) => a + b, 0) / binOf(0);
  const w = xs.slice(binOf(fromMs), binOf(toMs));
  return w.reduce((a, b) => a + b, 0) / w.length - base;
};
const floor = (x: number) => Math.max(x, 0.1);

if (import.meta.main) {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const pack = loadPack(arg("pack")!), tsv = arg("annotations")!, out = resolve(arg("out")!);
  mkdirSync(out, { recursive: true });

  const lines = readFileSync(tsv, "utf8").split("\n"), h = lines[0]!.replace(/\r$/, "").split("\t"), c = (n: string) => h.indexOf(n);
  const rows = lines.slice(1).map((l) => l.replace(/\r$/, "").split("\t")).filter((f) => f.length === h.length);
  const idx = (pred: (f: string[]) => boolean) => Int32Array.from(rows.flatMap((f, i) => (pred(f) ? [i] : [])));
  const sugar = idx((f) => f[c("cell_class")] === "gustatory" && f[c("cell_sub_class")] === "sugar/water");
  const bitter = idx((f) => f[c("cell_class")] === "gustatory" && f[c("cell_sub_class")] === "bitter");
  const otherSensory = Array.from(idx((f) => f[c("super_class")] === "sensory" && !["gustatory", "olfactory", "visual"].includes(f[c("cell_class")]!)));
  const neutral = Int32Array.from(sampleWithoutReplacement(otherSensory, 65, mulberry32(1)));
  const pops = {
    pam: idx((f) => f[c("cell_class")] === "DAN" && f[c("cell_type")]!.startsWith("PAM")),
    ppl: idx((f) => f[c("cell_class")] === "DAN" && f[c("cell_type")]!.startsWith("PPL")),
    ht: idx((f) => f[c("known_nt")]!.split(/[,;]/).map((s) => s.trim()).includes("serotonin")),
  };
  const all = Int32Array.from({ length: rows.length }, (_, i) => i);

  // Frontal map from the annotation positions (voxels): x left-right, y dorsal-ventral.
  const px = rows.map((f) => Number(f[c("pos_x")])), py = rows.map((f) => Number(f[c("pos_y")]));
  const ok = (v: number) => Number.isFinite(v) && v > 0;
  const q = (arr: number[], p: number) => { const s = arr.filter(ok).sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]!; };
  const [x0, x1, y0, y1] = [q(px, 0.002), q(px, 0.998), q(py, 0.002), q(py, 0.998)];
  const cell = Int32Array.from(rows.map((_, i) => {
    if (!ok(px[i]!) || !ok(py[i]!)) return -1;
    const gx = Math.floor(((px[i]! - x0) / (x1 - x0)) * GRID_W), gy = Math.floor(((py[i]! - y0) / (y1 - y0)) * GRID_H);
    return gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H ? -1 : gy * GRID_W + gx;
  }));
  const density = new Array(GRID_W * GRID_H).fill(0);
  cell.forEach((g) => { if (g >= 0) density[g]++; });
  const popCells = Object.fromEntries(Object.entries(pops).map(([k, v]) => [k, [...new Set(Array.from(v, (i) => cell[i]!).filter((g) => g >= 0))]]));

  // Label sets: AS-BUILT plus the two G2 extremes for sensitivity.
  const allnSigns = (u: 1 | -1) => new Map(rows.flatMap((f, i) => {
    if (f[c("cell_class")] !== "ALLN") return [];
    const l = alnLabel(f[c("known_nt")]!, f[c("top_nt")]!, Number(f[c("top_nt_conf")]));
    return [[i, l === "uncertain" ? u : l] as [number, 1 | -1]];
  }));
  const shuffled = signPreservingTargetShuffle(pack, 1001);
  const variants: [string, () => LifSim][] = [
    ["AS-BUILT", () => new LifSim(pack)],
    ["CORRECTED-U+", () => new LifSim(pack, { effectiveWeight: relabel(pack, allnSigns(1)) })],
    ["CORRECTED-U-", () => new LifSim(pack, { effectiveWeight: relabel(pack, allnSigns(-1)) })],
    ["SHUFFLED", () => new LifSim(shuffled)],
  ];

  const results: Record<string, unknown> = {};
  const movie: Record<string, number[][]> = {};
  const traces: Record<string, Trace> = {};
  for (const [name, make] of variants) {
    const t0 = Date.now(), sim = make();
    const run = (label: string, stims: Stim[], I: number, end = POST_END_MS, film = false) => {
      const g = film ? { cell, frames: [] as number[][] } : undefined;
      const tr = trial(sim, pops, all, stims, I, end, g);
      traces[`${name}|${label}|${I}`] = tr;
      if (g) movie[`${label}|${I}`] = g.frames;
      return tr;
    };
    const film = name === "AS-BUILT";
    const S: Record<string, Trace> = {};
    for (const I of [0.5, 1, 2]) {
      S[`sugar${I}`] = run("sugar", [{ neurons: sugar, onMs: 0 }], I, POST_END_MS, film && I === 1);
      S[`bitter${I}`] = run("bitter", [{ neurons: bitter, onMs: 0 }], I, POST_END_MS, film && I === 1);
      S[`neutral${I}`] = run("neutral", [{ neurons: neutral, onMs: 0 }], I);
    }
    const pairAfter = run("bitter-then-sugar", [{ neurons: bitter, onMs: 0 }, { neurons: sugar, onMs: 700 }], 1, POST_END_MS, film);
    const sugarLate = run("sugar-at-700", [{ neurons: sugar, onMs: 700 }], 1);

    const D = (tr: Trace, pop: keyof Trace, from = 0, to = STIM_MS) => delta(tr[pop], from, to);
    const valence = [1, 2].every((I) =>
      D(S[`sugar${I}`]!, "pam") > D(S[`bitter${I}`]!, "pam") && D(S[`bitter${I}`]!, "ppl") > D(S[`sugar${I}`]!, "ppl") &&
      D(S[`sugar${I}`]!, "pam") >= floor(2 * D(S[`neutral${I}`]!, "pam")) && D(S[`bitter${I}`]!, "ppl") >= floor(2 * D(S[`neutral${I}`]!, "ppl")));
    const scal = (k: "sugar" | "bitter", pop: keyof Trace) => D(S[`${k}0.5`]!, pop) < D(S[`${k}1`]!, pop) && D(S[`${k}1`]!, pop) < D(S[`${k}2`]!, pop);
    const scalability = scal("sugar", "pam") && scal("bitter", "ppl");
    const persist = (tr: Trace, pop: keyof Trace) => {
      const d = D(tr, pop), xs = tr[pop], base = 0;
      const bins = [binOf(200), binOf(250)].map((b) => xs[b]! - base);
      const last = xs[xs.length - 1]! - base;
      const brainBack = tr.brain[tr.brain.length - 1]! <= floor(2 * (tr.brain.slice(0, binOf(0)).reduce((a, b) => a + b, 0) / binOf(0)));
      return { d, holds: d > 0 && bins.every((v) => v > d / Math.E), back: Math.abs(last) <= 0.2 * Math.abs(d), brainBack, pass: d > 0 && bins.every((v) => v > d / Math.E) && Math.abs(last) <= 0.2 * Math.abs(d) && brainBack };
    };
    const pSugar = persist(S.sugar1!, "pam"), pBitter = persist(S.bitter1!, "ppl");
    const persistence = pSugar.pass && pBitter.pass;
    const alone = D(sugarLate, "pam", 700, 900), after = D(pairAfter, "pam", 700, 900);
    const generalization = Math.abs(after - alone) >= 0.2 * Math.abs(alone) && alone !== 0;
    const serotonin = [1, 2].some((I) => ["sugar", "bitter"].some((k) => Math.abs(D(S[`${k}${I}`]!, "ht")) >= floor(2 * Math.abs(D(S[`neutral${I}`]!, "ht")))));
    const stimBrain = D(S.sugar1!, "brain");
    results[name] = {
      valence, scalability, persistence, generalization, serotonin, stimBrainRate: stimBrain,
      deltas: Object.fromEntries(Object.entries(S).map(([k, tr]) => [k, { pam: D(tr, "pam"), ppl: D(tr, "ppl"), ht: D(tr, "ht"), brain: D(tr, "brain") }])),
      persistenceDetail: { sugarPam: pSugar, bitterPpl: pBitter },
      generalizationDetail: { sugarAlonePam: alone, sugarAfterBitterPam: after },
      seconds: Math.round((Date.now() - t0) / 1000),
    };
    console.error(`${name}: valence ${valence} scalability ${scalability} persistence ${persistence} generalization ${generalization} serotonin ${serotonin} (${results[name] && (results[name] as { seconds: number }).seconds} s)`);
  }

  const real = results["AS-BUILT"] as { valence: boolean; scalability: boolean; persistence: boolean; generalization: boolean; stimBrainRate: number };
  const sh = results.SHUFFLED as { valence: boolean; scalability: boolean; persistence: boolean; stimBrainRate: number };
  const present = real.valence && real.scalability && real.persistence;
  const informative = sh.stimBrainRate > 0 && sh.stimBrainRate <= 2 * real.stimBrainRate && sh.stimBrainRate >= real.stimBrainRate / 2;
  const specific = present && informative && !(sh.valence && sh.scalability && sh.persistence);
  const verdict = { present, shuffleInformative: informative, connectomeSpecific: specific, generalization: present && real.generalization };

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(out, `${stamp}-e1.json`), JSON.stringify({ verdict, results, sizes: { sugar: sugar.length, bitter: bitter.length, neutral: neutral.length, pam: pops.pam.length, ppl: pops.ppl.length, ht: pops.ht.length } }, null, 2));
  writeFileSync(join(out, `${stamp}-e1-traces.json`), JSON.stringify({ binMs: BIN_MS, preMs: PRE_MS, stimMs: STIM_MS, traces }));
  writeFileSync(join(out, `${stamp}-e1-movie.json`), JSON.stringify({ gridW: GRID_W, gridH: GRID_H, binMs: BIN_MS, preMs: PRE_MS, density, popCells, movie }));
  console.log(JSON.stringify(verdict));
}
