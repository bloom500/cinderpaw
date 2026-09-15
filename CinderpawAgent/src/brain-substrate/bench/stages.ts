/**
 * Substrate validation (bench-results/brain/VALIDATION-LADDER.md): odor-like
 * stimuli on FlyWire, and how much two odors overlap at each stage of the
 * olfactory path. No learning, no reward, no accuracy.
 *
 * Step 1: an odor is a set of glomeruli; every ORN of those glomeruli is driven.
 * Step 2 (variant 2, criteria dated 2026-09-15 03:10 in the same file): the
 * same odors drive the uniglomerular PNs of their glomeruli instead, once with
 * everything intact (2a) and once with every ORN/ALLN -> ALPN edge silenced
 * (2b, a declared lesion).
 *
 * FlyWire-only: glomeruli and PN subclasses come from the annotation file the
 * pack was built from, since the pack itself does not carry cell types.
 *
 * bun run src/brain-substrate/bench/stages.ts --step 1|2 --pack <dir> --annotations <tsv> --out <dir>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mulberry32 } from "../../memory/fractal/prng.ts";
import { loadPack } from "../pack/load.ts";
import type { BrainPack } from "../pack/types.ts";
import { PATTERN_DRIVE_MV_PER_MS, READOUT_MS } from "../seams/pattern.ts";
import { LifSim } from "../sim/lif.ts";

export const ODOR_SIZES = [3, 8] as const;
export const ODORS_PER_SIZE = 8;
const BIN_MS = 5;

/** Mean pairwise Jaccard over a list of sets; 0 when fewer than two. */
export function meanJaccard(sets: Set<number>[]): number {
  let sum = 0, pairs = 0;
  for (let a = 0; a < sets.length; a++) {
    for (let b = a + 1; b < sets.length; b++) {
      let inter = 0;
      for (const x of sets[a]!) if (sets[b]!.has(x)) inter++;
      const union = sets[a]!.size + sets[b]!.size - inter;
      sum += union === 0 ? 0 : inter / union;
      pairs++;
    }
  }
  return pairs === 0 ? 0 : sum / pairs;
}

/** k distinct items from `from`, partial Fisher-Yates, deterministic under rand. */
export function sampleWithoutReplacement<T>(from: readonly T[], k: number, rand: () => number): T[] {
  if (k > from.length) throw new Error(`cannot draw ${k} of ${from.length}`);
  const a = from.slice();
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (a.length - i));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, k);
}

export interface OlfactoryMap {
  /** glomerulus name -> ORN neuron indices */
  glomeruli: Map<string, number[]>;
  /** glomerulus name -> uniglomerular PN indices (cell_type starts with "<glomerulus>_") */
  pnByGlomerulus: Map<string, number[]>;
  alpnUni: Int32Array;
  alpnMulti: Int32Array;
  alln: Int32Array;
}

/** Neuron index = row order of the annotation file, as buildFlyWirePack assigns it. */
export function readOlfactoryMap(annotationsTsv: string): OlfactoryMap {
  const lines = readFileSync(annotationsTsv, "utf8").split("\n");
  const header = lines[0]!.replace(/\r$/, "").split("\t");
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`${annotationsTsv} has no "${name}" column`);
    return i;
  };
  const cClass = col("cell_class"), cSub = col("cell_sub_class"), cType = col("cell_type");
  const glomeruli = new Map<string, number[]>();
  const uni: number[] = [], multi: number[] = [], alln: number[] = [];
  const uniType: [number, string][] = [];
  let i = 0;
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li]!.replace(/\r$/, "");
    if (!line) continue;
    const cells = line.split("\t");
    const type = cells[cType]!;
    if (cells[cClass] === "olfactory" && type.startsWith("ORN_")) {
      const g = type.slice(4);
      const list = glomeruli.get(g) ?? [];
      list.push(i);
      glomeruli.set(g, list);
    }
    if (cells[cClass] === "ALPN") {
      if (cells[cSub] === "uniglomerular") { uni.push(i); uniType.push([i, type]); }
      else if (cells[cSub] === "multiglomerular") multi.push(i);
    }
    if (cells[cClass] === "ALLN") alln.push(i);
    i++;
  }
  const pnByGlomerulus = new Map<string, number[]>();
  for (const g of glomeruli.keys()) pnByGlomerulus.set(g, uniType.filter(([, t]) => t.startsWith(`${g}_`)).map(([n]) => n));
  return { glomeruli, pnByGlomerulus, alpnUni: Int32Array.from(uni), alpnMulti: Int32Array.from(multi), alln: Int32Array.from(alln) };
}

export type StageMode = "orn" | "pn" | "pn-lesion";

export interface StageRow {
  mode: StageMode;
  k: number;
  inputGlomeruliOverlap: number;
  /** overlap of the driven neuron sets (ORNs in step 1, PNs in step 2) */
  drivenOverlap: number;
  meanDriven: number;
  alpnUniOverlap: number;
  alpnMultiOverlap: number;
  alpnAllOverlap: number;
  alpnUniFiringFrac: number;
  alpnMultiFiringFrac: number;
  kcOverlap: number;
  kcSparsityUnion: number;
  kcSparsityPerBin: number[];
  go: boolean;
}

/**
 * One stage measurement: 8 odors per size, seed 1, the chosen neurons driven for
 * READOUT_MS, firing sets per stage. `effectiveWeight` replaces the pack weights
 * (the 2b lesion, or relabelled signs) without rebuilding the pack.
 */
export function measureStages(pack: BrainPack, map: OlfactoryMap, mode: StageMode, effectiveWeight?: Float32Array, makeSim?: () => LifSim): StageRow[] {
  const kc = pack.populations.kc!;
  const names = [...map.glomeruli.keys()].sort();
  const sim = makeSim ? makeSim() : new LifSim(pack, effectiveWeight ? { effectiveWeight } : {});
  const firing = (pop: Int32Array, into: Set<number>) => sim.rates(pop).forEach((r, j) => { if (r > 0) into.add(pop[j]!); });
  const rows: StageRow[] = [];
  for (const k of ODOR_SIZES) {
    const rand = mulberry32(1);
    const gSets: Set<number>[] = [], drivenSets: Set<number>[] = [], uni: Set<number>[] = [], multi: Set<number>[] = [], all: Set<number>[] = [], kcs: Set<number>[] = [];
    const perBin = new Array(Math.round(READOUT_MS / BIN_MS)).fill(0);
    let drivenMean = 0;
    for (let o = 0; o < ODORS_PER_SIZE; o++) {
      const chosen = sampleWithoutReplacement(names, k, rand);
      gSets.push(new Set(chosen.map((g) => names.indexOf(g))));
      const source = mode === "orn" ? map.glomeruli : map.pnByGlomerulus;
      const driven = Int32Array.from(chosen.flatMap((g) => source.get(g)!));
      drivenSets.push(new Set(driven));
      drivenMean += driven.length / ODORS_PER_SIZE;
      sim.resetState();
      sim.inject(driven, new Float32Array(driven.length).fill(PATTERN_DRIVE_MV_PER_MS));
      const u = new Set<number>(), m = new Set<number>(), kk = new Set<number>();
      for (let b = 0; b < perBin.length; b++) {
        sim.resetRates();
        sim.step(BIN_MS);
        firing(map.alpnUni, u);
        firing(map.alpnMulti, m);
        const binKc = new Set<number>();
        firing(kc, binKc);
        for (const x of binKc) kk.add(x);
        perBin[b] += binKc.size / kc.length / ODORS_PER_SIZE;
      }
      sim.clearInput();
      uni.push(u); multi.push(m); kcs.push(kk);
      all.push(new Set([...u, ...m]));
    }
    const row: StageRow = {
      mode,
      k,
      inputGlomeruliOverlap: meanJaccard(gSets),
      drivenOverlap: meanJaccard(drivenSets),
      meanDriven: drivenMean,
      alpnUniOverlap: meanJaccard(uni),
      alpnMultiOverlap: meanJaccard(multi),
      alpnAllOverlap: meanJaccard(all),
      alpnUniFiringFrac: uni.reduce((s, x) => s + x.size, 0) / ODORS_PER_SIZE / map.alpnUni.length,
      alpnMultiFiringFrac: multi.reduce((s, x) => s + x.size, 0) / ODORS_PER_SIZE / map.alpnMulti.length,
      kcOverlap: meanJaccard(kcs),
      kcSparsityUnion: kcs.reduce((s, x) => s + x.size, 0) / ODORS_PER_SIZE / kc.length,
      kcSparsityPerBin: perBin,
      go: false,
    };
    // Criteria fixed in VALIDATION-LADDER.md before these ran: step 1 on the PNs, step 2 on the KCs.
    row.go = mode === "orn" ? row.alpnUniOverlap < 0.3 && row.alpnAllOverlap < 0.5 : row.kcOverlap < 0.3;
    rows.push(row);
  }
  return rows;
}

if (import.meta.main) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const step = arg("step") ?? "1";
  const packDir = arg("pack"), tsv = arg("annotations"), outArg = arg("out");
  if (!packDir || !tsv || !outArg || (step !== "1" && step !== "2")) {
    console.error("usage: bun run src/brain-substrate/bench/stages.ts --step 1|2 --pack <dir> --annotations <tsv> --out <dir>");
    process.exit(2);
  }
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });
  const pack = loadPack(packDir);
  const map = readOlfactoryMap(tsv);
  const kc = pack.populations.kc!;
  const names = [...map.glomeruli.keys()].sort();

  // 2b: nothing from an ORN or an ALLN reaches a PN.
  const lesion = Float32Array.from(pack.weight);
  const alpn = new Set([...map.alpnUni, ...map.alpnMulti]);
  let silenced = 0;
  for (const src of [...[...map.glomeruli.values()].flat(), ...map.alln]) {
    for (let e = pack.rowPtr[src]!; e < pack.rowPtr[src + 1]!; e++) {
      if (alpn.has(pack.colIdx[e]!) && lesion[e] !== 0) { lesion[e] = 0; silenced++; }
    }
  }

  const measure = (mode: StageMode): StageRow[] =>
    measureStages(pack, map, mode, mode === "pn-lesion" ? lesion : undefined);

  const rows = step === "1" ? measure("orn") : [...measure("pn"), ...measure("pn-lesion")];
  const f = (x: number) => x.toFixed(3);
  const passes = (mode: StageMode) => rows.filter((r) => r.mode === mode).every((r) => r.go);
  const verdict = step === "1"
    ? `Step 1 verdict (uni < 0.30 AND all < 0.50 at both sizes): ${passes("orn") ? "GO to step 2" : "STOP, investigate the olfactory mapping and antennal-lobe dynamics"}`
    : `Step 2 verdict (KC overlap < 0.30 at both sizes, 2a preferred, else 2b): ${passes("pn") ? "GO, variant 2 with the antennal lobe intact (2a)" : passes("pn-lesion") ? "GO, variant 2 with the antennal-lobe lesion (2b)" : "STOP, the mushroom body does not separate clean input; CinderBrain leaves the release"}`;
  const noPn = names.filter((g) => map.pnByGlomerulus.get(g)!.length === 0);
  const md = [
    `# CinderBrain validation step ${step}: overlap per stage`,
    ``,
    `pack: ${pack.manifest.packId}; ${names.length} glomeruli; ${map.alpnUni.length} uniglomerular + ${map.alpnMulti.length} multiglomerular ALPNs; ${kc.length} KCs; ${ODORS_PER_SIZE} odors per size; seed 1; drive ${PATTERN_DRIVE_MV_PER_MS} mV/ms for ${READOUT_MS} ms; APL as built`,
    ...(step === "2" ? [``, `lesion (2b) silences ${silenced} ORN/ALLN -> ALPN edges; glomeruli with no uniglomerular PN to drive: ${noPn.join(", ") || "none"}`] : []),
    ``,
    `| mode | k | glomeruli overlap | driven overlap | neurons driven | ALPN uni overlap | ALPN multi overlap | ALPN all overlap | uni firing | multi firing | KC overlap | KC sparsity (50 ms) | KC per ${BIN_MS} ms bin | GO |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.mode} | ${r.k} | ${f(r.inputGlomeruliOverlap)} | ${f(r.drivenOverlap)} | ${r.meanDriven.toFixed(0)} | ${f(r.alpnUniOverlap)} | ${f(r.alpnMultiOverlap)} | ${f(r.alpnAllOverlap)} | ${f(r.alpnUniFiringFrac)} | ${f(r.alpnMultiFiringFrac)} | ${f(r.kcOverlap)} | ${f(r.kcSparsityUnion)} | ${r.kcSparsityPerBin.map(f).join(" ")} | ${r.go ? "yes" : "no"} |`),
    ``,
    verdict,
    ``,
  ].join("\n");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(out, `${stamp}-stages-step${step}.json`), JSON.stringify(rows, null, 2));
  writeFileSync(join(out, `${stamp}-stages-step${step}.md`), md);
  console.log(md);
}
