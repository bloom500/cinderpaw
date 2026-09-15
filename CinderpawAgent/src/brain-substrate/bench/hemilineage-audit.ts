/** Transmitter-sign research track R1: literature and confident-prediction labels of antennal-lobe local neurons, per hemilineage. bun run src/brain-substrate/bench/hemilineage-audit.ts [annotations.tsv] */
import { readFileSync } from "node:fs";
import { alnLabel } from "./labels.ts";
const lines = readFileSync(process.argv[2] ?? "../data/flywire/Supplemental_file1_neuron_annotations.tsv", "utf8").split("\n");
const h = lines[0]!.replace(/\r$/, "").split("\t"); const c = (n: string) => h.indexOf(n);
const rows = lines.slice(1).map((l) => l.replace(/\r$/, "").split("\t")).filter((f) => f[c("cell_class")] === "ALLN");
const hl = new Map<string, { known: string[]; confident: string[]; uncertain: number; types: Set<string> }>();
for (const f of rows) {
  const key = f[c("ito_lee_hemilineage")] || "(none)";
  const e = hl.get(key) ?? hl.set(key, { known: [], confident: [], uncertain: 0, types: new Set() }).get(key)!;
  e.types.add(f[c("cell_type")]!);
  const lit = alnLabel(f[c("known_nt")]!, "", NaN);
  const l = alnLabel(f[c("known_nt")]!, f[c("top_nt")]!, Number(f[c("top_nt_conf")]));
  if (lit !== "uncertain") e.known.push(f[c("known_nt")]!.split(/[,;]/)[0]!);
  else if (l !== "uncertain") e.confident.push(f[c("top_nt")]!);
  else e.uncertain++;
}
const cnt = (a: string[]) => Object.entries(a.reduce<Record<string, number>>((m, k) => (m[k] = (m[k] ?? 0) + 1, m), {})).map(([k, v]) => `${k}:${v}`).join(" ") || "-";
console.log("| hemilineage | cells | literature | confident prediction (>=0.50) | uncertain | types |\n|---|---|---|---|---|---|");
for (const [k, e] of [...hl].sort((a, b) => b[1].uncertain - a[1].uncertain)) console.log(`| ${k} | ${e.known.length + e.confident.length + e.uncertain} | ${cnt(e.known)} | ${cnt(e.confident)} | ${e.uncertain} | ${[...e.types].slice(0, 6).join(", ")}${e.types.size > 6 ? ", ..." : ""} |`);
