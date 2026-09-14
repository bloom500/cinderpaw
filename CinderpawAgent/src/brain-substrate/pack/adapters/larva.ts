/**
 * Larva adapter: Winding et al. 2023 (Science, doi:10.1126/science.add9330),
 * Supplementary Data S1, as mirrored at
 * github.com/brain-networks/larval-drosophila-connectome (Supplementary-Data-S1.zip).
 *
 * What the zip actually contains (inspected 2026-09-14), under `Supplementary-Data-S1/`:
 *   all-all_connectivity_matrix.csv   2952 x 2952 dense matrix, header row = skids
 *                                     (first header cell empty), first column = source
 *                                     skid, cells are synapse counts as floats ("0.0").
 *                                     Rows are presynaptic, columns postsynaptic.
 *   ad_ / aa_ / dd_ / da_connectivity_matrix.csv   same shape, split by axon/dendrite;
 *                                     not read here, all-all is their sum.
 *   annotations.csv                   columns: left_id, right_id, celltype,
 *                                     additional_annotations, level_7_cluster.
 *                                     One row per left/right PAIR (1373 rows, 2610 skids;
 *                                     "no pair" marks a missing hemisphere). celltype values:
 *                                     sensory, KC, MBON, MBIN, PN, LHN, LN, CN, DN-VNC, ...
 *                                     additional_annotations is ";"-separated free text; for
 *                                     MBINs it is "DAN-x1" (dopaminergic), "OAN-x1"
 *                                     (octopaminergic) or "MBIN-x1" (transmitter unknown).
 *   inputs.csv, outputs.csv, celltype_axonio_ratio.csv, celltype_dendriteioratio.csv
 *                                     per-neuron I/O counts; not used.
 *
 * No column anywhere names a neurotransmitter for ordinary neurons (no GABA, no
 * glutamate), so every sign is +1 and every MBON valence is "approach". The
 * fixture's ATTRIBUTION.md says so. 346 of the 2952 matrix neurons have no
 * annotation row; they stay in the graph with no role.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SHIU_2024, type Compartment, type PackFiles, type Role } from "../types.ts";

export const LARVA_SYNAPSE_FLOOR = 5;

function splitCsvLine(line: string): string[] {
  // The S1 files have no quoted fields; a plain split is exact.
  return line.replace(/\r$/, "").split(",");
}

export function buildLarvaPack(srcDir: string, opts: { wSyn?: number } = {}): PackFiles {
  const dir = existsSync(join(srcDir, "Supplementary-Data-S1")) ? join(srcDir, "Supplementary-Data-S1") : srcDir;
  const wSyn = opts.wSyn ?? SHIU_2024.wSyn;

  // Neuron order = column order of the all-all matrix.
  const matrixLines = readFileSync(join(dir, "all-all_connectivity_matrix.csv"), "utf8").split("\n");
  const skids = splitCsvLine(matrixLines[0]!).slice(1);
  const N = skids.length;
  const indexOf = new Map<string, number>();
  skids.forEach((s, i) => indexOf.set(s, i));

  // Dense counts, row-major, presynaptic row -> postsynaptic column.
  const count = new Uint16Array(N * N);
  let rows = 0;
  for (let li = 1; li < matrixLines.length; li++) {
    const line = matrixLines[li]!;
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    const r = indexOf.get(cells[0]!);
    if (r === undefined) throw new Error(`all-all matrix row skid ${cells[0]} is not in the header`);
    if (cells.length !== N + 1) throw new Error(`all-all matrix row ${cells[0]} has ${cells.length - 1} cells, expected ${N}`);
    for (let c = 0; c < N; c++) {
      const v = Number(cells[c + 1]);
      if (v) count[r * N + c] = v;
    }
    rows++;
  }
  if (rows !== N) throw new Error(`all-all matrix has ${rows} rows but ${N} columns`);

  // Roles from annotations.csv.
  const roleOf = new Map<number, Set<Role>>();
  const annoOf = new Map<number, string>();
  const add = (i: number, role: Role) => {
    let s = roleOf.get(i);
    if (!s) roleOf.set(i, (s = new Set()));
    s.add(role);
  };
  const annoLines = readFileSync(join(dir, "annotations.csv"), "utf8").split("\n");
  const header = splitCsvLine(annoLines[0]!);
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`annotations.csv has no "${name}" column; found ${header.join(", ")}`);
    return i;
  };
  const cLeft = col("left_id"), cRight = col("right_id"), cType = col("celltype"), cExtra = col("additional_annotations");
  for (let li = 1; li < annoLines.length; li++) {
    if (!annoLines[li]!.trim()) continue;
    const cells = splitCsvLine(annoLines[li]!);
    const celltype = cells[cType]!;
    const extra = cells[cExtra] ?? "";
    for (const skid of [cells[cLeft]!, cells[cRight]!]) {
      const i = indexOf.get(skid);
      if (i === undefined) continue; // "no pair", or a skid absent from the matrix (4 of 2610)
      annoOf.set(i, extra);
      if (celltype === "sensory") add(i, "sensory");
      else if (celltype === "KC") add(i, "kc");
      else if (celltype === "MBON") add(i, "mbon");
      else if (celltype === "MBIN") {
        if (/\bDAN-/.test(extra)) { add(i, "dan"); add(i, "neuromodulator"); }
        if (/\bOAN-/.test(extra)) add(i, "neuromodulator");
      }
    }
  }
  const populations: Partial<Record<Role, number[]>> = {};
  for (const [i, roles] of roleOf) for (const r of roles) (populations[r] ??= []).push(i);
  for (const r of Object.keys(populations) as Role[]) populations[r]!.sort((a, b) => a - b);
  const kc = new Set(populations.kc ?? []);
  const mbon = populations.mbon ?? [];
  const dan = populations.dan ?? [];

  // CSR over connections with >= LARVA_SYNAPSE_FLOOR summed synapses; weight = +1 * count * wSyn.
  const rowPtr = new Int32Array(N + 1);
  const colIdxArr: number[] = [];
  const weightArr: number[] = [];
  const plasticEdgeIdx: number[] = [];
  const plasticSrc: number[] = [];
  const plasticComp: number[] = [];
  const compartmentOfMbon = new Map<number, number>();
  const compartments: Compartment[] = mbon.map((m, ci) => {
    compartmentOfMbon.set(m, ci);
    // DANs that synapse (>= 1, raw) onto at least one KC presynaptic (>= floor) to this MBON.
    const danIds = dan.filter((d) => {
      for (const k of kc) if (count[k * N + m]! >= LARVA_SYNAPSE_FLOOR && count[d * N + k]! >= 1) return true;
      return false;
    });
    return { id: `${(annoOf.get(m) ?? "MBON").split(";")[0]!.trim()}:${skids[m]}`, mbonValence: "approach", danIds: danIds.length ? danIds : dan };
  });
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const n = count[r * N + c]!;
      if (n < LARVA_SYNAPSE_FLOOR) continue;
      if (kc.has(r) && compartmentOfMbon.has(c)) {
        plasticEdgeIdx.push(colIdxArr.length);
        plasticSrc.push(r);
        plasticComp.push(compartmentOfMbon.get(c)!);
      }
      colIdxArr.push(c);
      weightArr.push(n * wSyn);
    }
    rowPtr[r + 1] = colIdxArr.length;
  }
  if (compartments.length > 127) throw new Error(`plastic.bin stores compartments as Int8; ${compartments.length} do not fit`);

  return {
    manifest: {
      packId: "larva-s1-v1",
      species: "Drosophila melanogaster (L1 larva)",
      source: { name: "Winding et al. 2023, Supplementary Data S1", doi: "10.1126/science.add9330", release: `S1, floor ${LARVA_SYNAPSE_FLOOR}` },
      completeness: "whole-brain",
      packFormatVersion: 1,
      simulatorAbiVersion: 1,
      license: "CC-BY-4.0",
      attributionFile: "ATTRIBUTION.md",
      neurons: N,
      edges: colIdxArr.length,
      plasticEdges: plasticEdgeIdx.length,
      simParams: { ...SHIU_2024, wSyn },
      seed: 783,
      populations,
      compartments,
      plasticity: { rule: "kc-mbon-depression-v1", eta: 0.1, maxDelta: null },
    },
    rowPtr,
    colIdx: Int32Array.from(colIdxArr),
    weight: Float32Array.from(weightArr),
    plastic: { edgeIdx: Int32Array.from(plasticEdgeIdx), src: Int32Array.from(plasticSrc), compartment: Int8Array.from(plasticComp) },
  };
}

export const LARVA_ATTRIBUTION = `# Attribution

This directory is a modified derivative of the Drosophila larva connectome:

Winding, M., Pedigo, B. D., Barnes, C. L., et al. (2023). The connectome of an
insect brain. Science 379, eadd9330. doi:10.1126/science.add9330

Data: Supplementary Data S1 (all-all_connectivity_matrix.csv, annotations.csv),
as mirrored at https://github.com/brain-networks/larval-drosophila-connectome.
The author manuscript is available on PMC (PMC7614541) under CC BY 4.0.

Modifications made when building this pack:

- synapse floor ${LARVA_SYNAPSE_FLOOR}: only connections with at least ${LARVA_SYNAPSE_FLOOR} summed synapses
  (axon and dendrite, all four matrices) are kept;
- signs assumed +1 unless annotated inhibitory. Supplementary Data S1 has no
  neurotransmitter column, so no connection is annotated inhibitory and every
  weight in this pack is positive;
- MBON valence is "approach" for every compartment, the Aso et al. 2014
  convention for an MBON of unknown transmitter;
- roles: celltype "sensory" -> sensory, "KC" -> kc, "MBON" -> mbon, MBINs
  annotated "DAN-*" -> dan, dan plus MBINs annotated "OAN-*" -> neuromodulator.
  Larvae have no mature central complex, so no persistent-state role.
`;
