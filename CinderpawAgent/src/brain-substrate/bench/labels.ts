/**
 * Variant 1, step G2 (VALIDATION-LADDER.md, section dated 2026-09-15 19:00):
 * the no-electrical-synapse reference with corrected antennal-lobe local neuron
 * (ALLN) transmitter labels. Measures step 1 under three label sets and reports
 * each overlap against an activity-matched random null. Nothing is selected.
 *
 * bun run src/brain-substrate/bench/labels.ts --pack <dir> --annotations <tsv> --out <dir>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mulberry32 } from "../../memory/fractal/prng.ts";
import { loadPack } from "../pack/load.ts";
import type { BrainPack } from "../pack/types.ts";
import { measureStages, meanJaccard, readOlfactoryMap, sampleWithoutReplacement, type StageRow } from "./stages.ts";

/** Preregistered; not tuned after any G2 number exists. */
export const CONFIDENCE_THRESHOLD = 0.5;

export type Label = 1 | -1 | "uncertain";

/** The G2 label rule: literature first, a confident prediction second, otherwise uncertain. */
export function alnLabel(knownNt: string, topNt: string, conf: number): Label {
  const first = knownNt.split(/[,;]/)[0]!.trim().toLowerCase();
  if (first === "gaba" || first === "glutamate") return -1;
  if (first === "acetylcholine") return 1;
  if (!(conf >= CONFIDENCE_THRESHOLD)) return "uncertain";
  return topNt === "gaba" || topNt === "glutamate" ? -1 : 1;
}

/** Pack weights with every outgoing edge of each relabelled neuron given its new sign. */
export function relabel(pack: BrainPack, signs: Map<number, 1 | -1>): Float32Array {
  const w = Float32Array.from(pack.weight);
  for (const [n, s] of signs) {
    for (let e = pack.rowPtr[n]!; e < pack.rowPtr[n + 1]!; e++) w[e] = Math.abs(w[e]!) * s;
  }
  return w;
}

/** Mean Jaccard expected by chance for sets of these sizes drawn from `population`. */
export function nullJaccard(sizes: number[], population: ArrayLike<number>, draws: number, seed: number): number {
  const rand = mulberry32(seed), pop = Array.from(population);
  let sum = 0;
  for (let d = 0; d < draws; d++) sum += meanJaccard(sizes.map((k) => new Set(sampleWithoutReplacement(pop, Math.min(k, pop.length), rand))));
  return sum / draws;
}

if (import.meta.main) {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const packDir = arg("pack"), tsv = arg("annotations"), outArg = arg("out");
  if (!packDir || !tsv || !outArg) {
    console.error("usage: bun run src/brain-substrate/bench/labels.ts --pack <dir> --annotations <tsv> --out <dir>");
    process.exit(2);
  }
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });
  const pack = loadPack(packDir);
  const map = readOlfactoryMap(tsv);

  const lines = readFileSync(tsv, "utf8").split("\n");
  const header = lines[0]!.replace(/\r$/, "").split("\t");
  const cClass = header.indexOf("cell_class"), cKnown = header.indexOf("known_nt"), cTop = header.indexOf("top_nt"), cConf = header.indexOf("top_nt_conf");
  const labels = new Map<number, Label>();
  let idx = 0;
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li]!.replace(/\r$/, "");
    if (!line) continue;
    const f = line.split("\t");
    if (f[cClass] === "ALLN") labels.set(idx, alnLabel(f[cKnown]!, f[cTop]!, Number(f[cConf])));
    idx++;
  }
  const signsFor = (u: 1 | -1) => new Map([...labels].map(([n, l]) => [n, l === "uncertain" ? u : l] as [number, 1 | -1]));
  const nUncertain = [...labels.values()].filter((l) => l === "uncertain").length;
  const asBuiltNeg = [...labels.keys()].filter((n) => { const e = pack.rowPtr[n]!; return e < pack.rowPtr[n + 1]! && pack.weight[e]! < 0; }).length;
  const flippedFromBuilt = (u: 1 | -1) => [...signsFor(u)].filter(([n, s]) => { const e = pack.rowPtr[n]!; return e < pack.rowPtr[n + 1]! && Math.sign(pack.weight[e]!) !== s; }).length;

  const sets: [string, Float32Array | undefined][] = [["AS-BUILT", undefined], ["CORRECTED-U+", relabel(pack, signsFor(1))], ["CORRECTED-U-", relabel(pack, signsFor(-1))]];
  const results: { set: string; rows: StageRow[] }[] = [];
  for (const [name, w] of sets) {
    const t0 = Date.now();
    results.push({ set: name, rows: measureStages(pack, map, "orn", w) });
    console.error(`${name} measured in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }

  // Null ratios need the firing-set sizes, which StageRow keeps only as fractions; recompute sizes from them.
  const f = (x: number) => x.toFixed(3);
  const kcN = pack.populations.kc!.length, uniN = map.alpnUni.length;
  const rowsMd = results.flatMap(({ set, rows }) => rows.map((r) => {
    const uniNull = nullJaccard(new Array(8).fill(Math.round(r.alpnUniFiringFrac * uniN)), map.alpnUni, 1000, 7);
    const kcNull = nullJaccard(new Array(8).fill(Math.round(r.kcSparsityUnion * kcN)), pack.populations.kc!, 200, 7);
    return `| ${set} | ${r.k} | ${f(r.alpnUniOverlap)} | ${f(uniNull)} | ${f(r.alpnUniOverlap / (uniNull || NaN))} | ${f(r.alpnAllOverlap)} | ${f(r.alpnUniFiringFrac)} | ${f(r.kcOverlap)} | ${f(kcNull)} | ${f(r.kcOverlap / (kcNull || NaN))} | ${f(r.kcSparsityUnion)} | ${r.go ? "yes" : "no"} |`;
  }));

  const uni = (set: string, k: number) => results.find((x) => x.set === set)!.rows.find((r) => r.k === k)!;
  const material = ["CORRECTED-U+", "CORRECTED-U-"].some((s) => [3, 8].every((k) => Math.abs(uni(s, k).alpnUniOverlap - uni("AS-BUILT", k).alpnUniOverlap) >= 0.1));
  const step1 = (s: string) => [3, 8].every((k) => uni(s, k).go);
  const decisive = step1("CORRECTED-U+") !== step1("CORRECTED-U-");
  const md = [
    `# CinderBrain Variant 1 step G2: corrected ALLN labels, no electrical synapses`,
    ``,
    `pack: ${pack.manifest.packId}; ALLNs ${labels.size}; uncertain (no literature label, top_nt_conf < ${CONFIDENCE_THRESHOLD}) ${nUncertain}; ALLNs inhibitory as built ${asBuiltNeg}; signs changed vs built: U+ ${flippedFromBuilt(1)}, U- ${flippedFromBuilt(-1)}. Stimulus = step 1 (ORNs, k=3/8, 8 odors, seed 1). Null = same-size random sets from the same population (uni 1000 draws, KC 200 draws).`,
    ``,
    `| label set | k | uni PN overlap | null | ratio | all ALPN overlap | uni firing | KC overlap | null | ratio | KC sparsity | step-1 criterion |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|`,
    ...rowsMd,
    ``,
    `LABEL EFFECT: ${material ? "MATERIAL (uni overlap moves >= 0.10 at both k in a corrected set)" : "SMALL"}`,
    `UNCERTAIN CELLS: ${decisive ? "DECISIVE (step-1 criterion passes in exactly one corrected set; later claims must hold in both)" : "not decisive by the step-1 criterion"}`,
    ``,
  ].join("\n");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(join(out, `${stamp}-g2-labels.json`), JSON.stringify({ nUncertain, results }, null, 2));
  writeFileSync(join(out, `${stamp}-g2-labels.md`), md);
  console.log(md);
}
