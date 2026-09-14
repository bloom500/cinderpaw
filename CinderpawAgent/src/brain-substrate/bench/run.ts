/**
 * bun run brain:bench --pack <dir|fixture> --seeds 3 --shuffles 2 [--pairs 200] [--interference 500] --out <dir>
 *
 * Writes <out>/<iso>-synthetic.json (every row) and <out>/<iso>-synthetic.md
 * (median and min/max per condition, one verdict line). "yes" needs the real
 * median above the shuffled median by more than the larger spread (spec 7).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPack } from "../pack/load.ts";
import { fixtureCircuit } from "../sim/fixture-circuit.ts";
import { degreeSignPreservingShuffle } from "../sim/shuffle.ts";
import { densePlasticPack, runPlasticityBench, type SyntheticResult } from "./synthetic.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const packArg = arg("pack");
const out = arg("out");
if (!packArg || !out) {
  console.error("usage: bun run brain:bench --pack <dir|fixture> --seeds N --shuffles N [--pairs N] [--interference N] --out <dir>");
  process.exit(2);
}
const seeds = Number(arg("seeds", "3"));
const shuffles = Number(arg("shuffles", "2"));
const pairs = Number(arg("pairs", "200"));
const interference = Number(arg("interference", "500"));

const pack = packArg === "fixture" ? fixtureCircuit() : loadPack(packArg);
const dense = densePlasticPack(pack);
const rows: SyntheticResult[] = [];
const t0 = performance.now();
for (let seed = 1; seed <= seeds; seed++) {
  rows.push(runPlasticityBench(pack, { condition: "real", seed, pairs, interference, plasticity: true }));
  rows.push(runPlasticityBench(pack, { condition: "real", seed, pairs, interference, plasticity: false }));
  rows.push(runPlasticityBench(dense, { condition: "dense", seed, pairs, interference, plasticity: true }));
  for (let sh = 1; sh <= shuffles; sh++) {
    const shuffleSeed = 1000 + sh;
    rows.push(runPlasticityBench(degreeSignPreservingShuffle(pack, shuffleSeed), { condition: "shuffled", seed, shuffleSeed, pairs, interference, plasticity: true }));
  }
  console.error(`seed ${seed}/${seeds} done, ${((performance.now() - t0) / 1000).toFixed(0)}s`);
}

const stats = (sel: (r: SyntheticResult) => boolean) => {
  const a = rows.filter(sel).map((r) => r.accuracy).sort((x, y) => x - y);
  const med = a.length === 0 ? NaN : a.length % 2 ? a[(a.length - 1) / 2]! : (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2;
  return { n: a.length, median: med, min: a[0] ?? NaN, max: a[a.length - 1] ?? NaN, spread: (a[a.length - 1] ?? 0) - (a[0] ?? 0) };
};
const real = stats((r) => r.condition === "real" && r.plasticity);
const off = stats((r) => r.condition === "real" && !r.plasticity);
const shuffled = stats((r) => r.condition === "shuffled");
const denseS = stats((r) => r.condition === "dense");
const yes = real.median > shuffled.median + Math.max(real.spread, shuffled.spread);
const sparsity = rows.filter((r) => r.condition === "real" && r.plasticity).reduce((a, r) => a + r.kcSparsity, 0) / Math.max(1, real.n);
const f = (x: number) => (Number.isNaN(x) ? "n/a" : x.toFixed(3));
const line = (name: string, s: ReturnType<typeof stats>) => `| ${name} | ${s.n} | ${f(s.median)} | ${f(s.min)} | ${f(s.max)} | ${f(s.spread)} |`;
const verdict = `real (median accuracy ${f(real.median)}) vs shuffled median ${f(shuffled.median)} vs dense ${f(denseS.median)}  ->  REAL > SHUFFLED: ${yes ? "yes" : "no"} (margin ${f(real.median - shuffled.median)}, spread real ${f(real.spread)} / shuffled ${f(shuffled.spread)})`;
const md = [
  `# CinderBrain synthetic plasticity bench`,
  ``,
  `pack: ${pack.manifest.packId} (${pack.manifest.neurons} neurons, ${pack.manifest.edges} edges, ${pack.manifest.plasticEdges} plastic); seeds ${seeds}; shuffles ${shuffles}; pairs ${pairs}; interference ${interference}; chance 0.5`,
  `kc sparsity (real, plasticity on): ${f(sparsity)} of KCs fire per pattern; wall ${((performance.now() - t0) / 1000).toFixed(0)}s`,
  ``,
  `| condition | n | median | min | max | spread |`,
  `|---|---|---|---|---|---|`,
  line("real, plasticity on", real),
  line("real, plasticity off", off),
  line("shuffled", shuffled),
  line("dense", denseS),
  ``,
  verdict,
  ``,
].join("\n");

mkdirSync(out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(join(out, `${stamp}-synthetic.json`), JSON.stringify(rows, null, 2));
writeFileSync(join(out, `${stamp}-synthetic.md`), md);
console.log(md);
