/**
 * Variant 1, step G4 (VALIDATION-LADDER.md, 2026-09-15 21:45): local and global inhibition
 * in the FlyWire antennal lobe, no electrical synapses. Every condition of the preregistered
 * grid is run and reported; Q1-Q3 verdicts are computed exactly as written there.
 *
 * bun run src/brain-substrate/bench/g4.ts --pack <dir> --annotations <tsv> --synapses <tsv> --out <dir>
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mulberry32 } from "../../memory/fractal/prng.ts";
import { loadPack } from "../pack/load.ts";
import { AlSim, type AlSynapseRow } from "../sim/al-sim.ts";
import { alnLabel, relabel, typeConsensus, type AllnCell, type Label } from "./labels.ts";
import { measureStages, readOlfactoryMap, sampleWithoutReplacement } from "./stages.ts";

/** FlyWire glomeruli with a single Hallem & Carlson 2006 receptor (variant1/04-hallem-coverage-raw.txt; Or33b's DM5+DM3 excluded). */
export const HALLEM_GLOMERULI = ["DL1", "DC1", "DM2", "DA3", "DA4m", "VC3", "DA4l", "VM2", "DM3", "VA1v", "VA5", "DM4", "DL3", "DM6", "VC4", "DL5", "VA6", "DM5", "VM5d", "DL4", "VA1d", "VM5v", "VM3"];
const DRIVE = 2;

/** Median; Infinity counts as a large value. */
export const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN; };

if (import.meta.main) {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const packDir = arg("pack")!, tsv = arg("annotations")!, synTsv = arg("synapses")!, out = resolve(arg("out")!);
  mkdirSync(out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const partial = join(out, `${stamp}-g4.partial.jsonl`);
  const pack = loadPack(packDir), map = readOlfactoryMap(tsv);

  // Annotations: ALLN labels, lLN2P subtypes.
  const lines = readFileSync(tsv, "utf8").split("\n"), h = lines[0]!.replace(/\r$/, "").split("\t"), col = (n: string) => h.indexOf(n);
  const allnIdx: number[] = [], allnCells: AllnCell[] = [];
  let idx = 0;
  for (const raw of lines.slice(1)) {
    const f = raw.replace(/\r$/, "").split("\t");
    if (f.length < h.length) continue;
    if (f[col("cell_class")] === "ALLN") { allnIdx.push(idx); allnCells.push({ type: f[col("cell_type")]!, known: f[col("known_nt")]!, top: f[col("top_nt")]!, conf: Number(f[col("top_nt_conf")]) }); }
    idx++;
  }
  const own = allnCells.map((c) => alnLabel(c.known, c.top, c.conf)), tc = typeConsensus(allnCells);
  const signs = (labels: Label[], u: 1 | -1) => new Map(labels.map((l, j) => [allnIdx[j]!, l === "uncertain" ? u : l] as [number, 1 | -1]));
  const LABEL_SETS: [string, Map<number, 1 | -1>][] = [["CORRECTED-U+", signs(own, 1)], ["CORRECTED-U-", signs(own, -1)], ["TYPE-CONSENSUS/T+", signs(tc, 1)], ["TYPE-CONSENSUS/T-", signs(tc, -1)]];
  const ofType = (prefix: string) => allnIdx.filter((_, j) => allnCells[j]!.type.startsWith(prefix));
  const PATCHY: [string, number[]][] = [["all lLN2P", ofType("lLN2P_")], ["lLN2P_a", ofType("lLN2P_a")], ["lLN2P_b", ofType("lLN2P_b")], ["lLN2P_c", ofType("lLN2P_c")]];
  const GHALF = [1, 4, 16], PRIMARY_GHALF = 4;

  const synapses: AlSynapseRow[] = readFileSync(synTsv, "utf8").split("\n").slice(1).filter(Boolean).map((l) => {
    const [pre, post, glomerulus, s] = l.replace(/\r$/, "").split("\t");
    return { pre: Number(pre), post: Number(post), glomerulus: glomerulus!, synapses: Number(s) };
  });
  const orns = [...map.glomeruli.values()].flat();
  const names = [...map.glomeruli.keys()].sort();

  // P2 draws, fixed before any condition runs.
  const tests = sampleWithoutReplacement(HALLEM_GLOMERULI.filter((g) => map.glomeruli.has(g)), 5, mulberry32(1));
  const publics = new Map(tests.map((t) => [t, sampleWithoutReplacement(names.filter((g) => g !== t), 16, mulberry32(1))]));

  type Cond = { label: string; mech: "BASE" | "PATCHY" | "PRESYN" | "BOTH"; patchy: string | null; gHalf: number | null };
  const conds: Cond[] = [];
  for (const [label] of LABEL_SETS) {
    conds.push({ label, mech: "BASE", patchy: null, gHalf: null });
    for (const [pv] of PATCHY) conds.push({ label, mech: "PATCHY", patchy: pv, gHalf: null });
    for (const gh of GHALF) conds.push({ label, mech: "PRESYN", patchy: null, gHalf: gh });
    for (const [pv] of PATCHY) for (const gh of GHALF) conds.push({ label, mech: "BOTH", patchy: pv, gHalf: gh });
  }

  const results: Record<string, unknown>[] = [];
  const ids = (xs: number[]) => Int32Array.from(xs);
  for (const [ci, c] of conds.entries()) {
    const t0 = Date.now();
    const w = relabel(pack, LABEL_SETS.find(([l]) => l === c.label)![1]);
    const make = () => new AlSim(pack, {
      effectiveWeight: w, synapses, orns, localNeurons: allnIdx,
      ...(c.patchy ? { patchy: PATCHY.find(([p]) => p === c.patchy)![1] } : {}),
      ...(c.gHalf !== null ? { gHalf: c.gHalf } : {}),
    });
    const sim = make();
    const row: Record<string, unknown> = { ...c };

    if (c.patchy) {
      const ratios: number[] = [];
      for (const g of names) {
        sim.resetState();
        sim.inject(ids(map.glomeruli.get(g)!), new Float32Array(map.glomeruli.get(g)!.length).fill(DRIVE));
        sim.step(50);
        sim.clearInput();
        const d = sim.compartmentDepolarisation();
        const byCell = new Map<number, number[]>();
        sim.compCell.forEach((cell, k) => (byCell.get(cell) ?? byCell.set(cell, []).get(cell)!).push(k));
        for (const [, ks] of byCell) {
          const inG = ks.find((k) => sim.compGlom[k] === g);
          if (inG === undefined || ks.length < 2) continue;
          const others = ks.filter((k) => k !== inG).map((k) => d[k]!);
          const mean = others.reduce((a, b) => a + b, 0) / others.length;
          ratios.push(mean > 0 ? d[inG]! / mean : d[inG]! > 0 ? Infinity : 0);
        }
      }
      row.q1MedianRatio = median(ratios);
      row.q1Pairs = ratios.length;
      row.local = median(ratios) >= 3;
    }

    if (c.mech !== "PATCHY") {
      const byN: Record<number, { pn: number; p: number }> = {};
      for (const n of [0, 4, 16]) {
        let pn = 0, pp = 0;
        for (const t of tests) {
          const driven = [t, ...publics.get(t)!.slice(0, n)].flatMap((g) => map.glomeruli.get(g)!);
          sim.resetState();
          sim.inject(ids(driven), new Float32Array(driven.length).fill(DRIVE));
          sim.step(50);
          sim.resetRates();
          sim.step(250);
          sim.clearInput();
          const pns = map.pnByGlomerulus.get(t)!;
          const r = sim.rates(ids(pns));
          pn += (pns.length ? r.reduce((a, b) => a + b, 0) / pns.length : 0) / tests.length;
          pp += sim.meanP(map.glomeruli.get(t)!) / tests.length;
        }
        byN[n] = { pn, p: pp };
      }
      row.p2 = byN;
    }

    const stages = measureStages(pack, map, "orn", w, make);
    row.p3 = stages.map((s) => ({ k: s.k, uni: s.alpnUniOverlap, all: s.alpnAllOverlap, uniFiring: s.alpnUniFiringFrac, kc: s.kcOverlap, kcActive: s.kcSparsityUnion }));
    row.seconds = Math.round((Date.now() - t0) / 1000);
    results.push(row);
    appendFileSync(partial, JSON.stringify(row) + "\n");
    console.error(`[${ci + 1}/${conds.length}] ${c.label} ${c.mech} ${c.patchy ?? "-"} gHalf=${c.gHalf ?? "-"} ${row.seconds} s`);
  }

  // Verdicts, as preregistered.
  type P2 = Record<number, { pn: number; p: number }>;
  const find = (label: string, mech: string, patchy: string | null, gHalf: number | null) =>
    results.find((r) => r.label === label && r.mech === mech && r.patchy === patchy && r.gHalf === gHalf)!;
  const ratio = (p2: P2) => p2[16]!.pn / p2[0]!.pn;
  const global = (r: Record<string, unknown>) => {
    const p2 = r.p2 as P2, base = find(r.label as string, "BASE", null, null).p2 as P2;
    return p2[0]!.pn > p2[4]!.pn && p2[4]!.pn > p2[16]!.pn && ratio(p2) <= ratio(base) - 0.1 && p2[0]!.p > p2[4]!.p && p2[4]!.p > p2[16]!.p;
  };
  const labels = LABEL_SETS.map(([l]) => l);
  const q1Rows = results.filter((r) => r.patchy);
  const q1Robust = q1Rows.every((r) => r.local === true);
  const q1Primary = labels.every((l) => ["PATCHY", "BOTH"].every((m) => (find(l, m, "all lLN2P", m === "BOTH" ? PRIMARY_GHALF : null).local as boolean)));
  const q2Rows = results.filter((r) => r.mech === "PRESYN" || (r.mech === "BOTH" && r.patchy === "all lLN2P"));
  const q2Robust = q2Rows.every(global);
  const q2Primary = labels.every((l) => global(find(l, "PRESYN", null, PRIMARY_GHALF)) && global(find(l, "BOTH", "all lLN2P", PRIMARY_GHALF)));
  const verdict = (robust: boolean, primary: boolean) => (robust ? "ROBUST" : primary ? "holds, parameter-sensitive" : "not robust");

  const f = (x: unknown) => (typeof x === "number" ? (Number.isFinite(x) ? x.toFixed(3) : String(x)) : String(x ?? "-"));
  const md = [
    `# CinderBrain Variant 1 step G4: local and global inhibition (no electrical synapses)`,
    ``,
    `pack ${pack.manifest.packId}; test glomeruli ${tests.join(", ")}; public draws nested (n = 4 is the first 4 of the 16); ${conds.length} conditions.`,
    ``,
    `Q1 LOCAL (median compartment ratio >= 3): ${q1Rows.filter((r) => r.local).length}/${q1Rows.length} conditions pass -> ${verdict(q1Robust, q1Primary)}`,
    `Q2 GLOBAL (PN falls with n, ratio 0.10 below BASE, p falls): ${q2Rows.filter(global).length}/${q2Rows.length} conditions pass -> ${verdict(q2Robust, q2Primary)}`,
    ``,
    `| label set | mech | patchy | gHalf | Q1 median ratio (pairs) | LOCAL | PN n=0/4/16 Hz | p n=0/4/16 | R16/R0 | GLOBAL | uni overlap k3/k8 | uni firing k3/k8 | KC overlap k3/k8 | KC active k3/k8 |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
    ...results.map((r) => {
      const p2 = r.p2 as P2 | undefined, p3 = r.p3 as { uni: number; uniFiring: number; kc: number; kcActive: number }[];
      return `| ${r.label} | ${r.mech} | ${r.patchy ?? "-"} | ${r.gHalf ?? "-"} | ${r.patchy ? `${f(r.q1MedianRatio)} (${r.q1Pairs})` : "-"} | ${r.patchy ? (r.local ? "yes" : "no") : "-"} | ${p2 ? [0, 4, 16].map((n) => p2[n]!.pn.toFixed(1)).join(" / ") : "-"} | ${p2 ? [0, 4, 16].map((n) => p2[n]!.p.toFixed(3)).join(" / ") : "-"} | ${p2 ? f(ratio(p2)) : "-"} | ${p2 && r.mech !== "BASE" ? (global(r) ? "yes" : "no") : "-"} | ${p3.map((s) => f(s.uni)).join(" / ")} | ${p3.map((s) => f(s.uniFiring)).join(" / ")} | ${p3.map((s) => f(s.kc)).join(" / ")} | ${p3.map((s) => f(s.kcActive)).join(" / ")} |`;
    }),
    ``,
  ].join("\n");
  writeFileSync(join(out, `${stamp}-g4.md`), md);
  writeFileSync(join(out, `${stamp}-g4.json`), JSON.stringify({ tests, publics: Object.fromEntries(publics), results }, null, 2));
  console.log(md);
}
