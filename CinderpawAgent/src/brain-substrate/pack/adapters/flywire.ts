/**
 * FlyWire adapter: the adult Drosophila connectome, v783 (spec section 2.3).
 *
 * Inputs, under srcDir:
 *   proofread_connections_783.feather   Zenodo 10676866 (Dorkenwald et al. 2024). Inspected
 *                                       2026-09-14: 16,847,997 rows, zstd-compressed record
 *                                       batches, columns pre_pt_root_id, post_pt_root_id (the plan
 *                                       said pre_root_id), neuropil, syn_count, and six *_avg
 *                                       transmitter scores. syn_count is summed over neuropils here.
 *   Supplemental_file1_neuron_annotations.tsv   flyconnectome/flywire_annotations (Schlegel et
 *                                       al. 2024): root_id, super_class, cell_class, cell_type,
 *                                       top_nt. Inspected 2026-09-14: 139,248 rows; there is no
 *                                       cell_class "OAN", octopaminergic neurons are found by
 *                                       top_nt == "octopamine" (216).
 *
 * Neurons are the annotated ids, in file order. Connections with an unannotated
 * endpoint are dropped and counted. Sign is the presynaptic neuron's top_nt:
 * acetylcholine, dopamine, serotonin, octopamine +1; gaba, glutamate -1; the 602
 * with no top_nt are +1 and counted. Weight = sign * syn_count * wSyn.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CompressionType, compressionRegistry, tableFromIPC } from "apache-arrow";
import { SHIU_2024, type Compartment, type PackFiles, type Role } from "../types.ts";

export const FLYWIRE_SYNAPSE_FLOOR = 5;
const CONNECTIONS = "proofread_connections_783.feather";
const ANNOTATIONS = "Supplemental_file1_neuron_annotations.tsv";
const PERSISTENT_STATE_PREFIXES = ["EPG", "PEN", "PEG", "Delta7"];

export interface FlyWireBuildReport {
  droppedUnannotated: number;
  unknownTransmitter: number;
  belowFloor: number;
}

export function buildFlyWirePack(
  srcDir: string,
  opts: { wSyn?: number; synapseFloor?: number; report?: FlyWireBuildReport } = {},
): PackFiles {
  const wSyn = opts.wSyn ?? SHIU_2024.wSyn;
  const floor = opts.synapseFloor ?? FLYWIRE_SYNAPSE_FLOOR;
  const report: FlyWireBuildReport = opts.report ?? { droppedUnannotated: 0, unknownTransmitter: 0, belowFloor: 0 };

  // Annotations: neuron order, sign, roles.
  const lines = readFileSync(join(srcDir, ANNOTATIONS), "utf8").split("\n");
  const header = lines[0]!.replace(/\r$/, "").split("\t");
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`${ANNOTATIONS} has no "${name}" column; found ${header.join(", ")}`);
    return i;
  };
  const cRoot = col("root_id"), cSuper = col("super_class"), cClass = col("cell_class"), cType = col("cell_type"), cNt = col("top_nt");
  const indexOf = new Map<bigint, number>();
  const sign: number[] = [];
  const cellType: string[] = [];
  const topNt: string[] = [];
  const rootId: bigint[] = [];
  const populations: Partial<Record<Role, number[]>> = {};
  const add = (i: number, role: Role) => (populations[role] ??= []).push(i);
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li]!.replace(/\r$/, "");
    if (!line) continue;
    const cells = line.split("\t");
    const i = indexOf.size;
    const id = BigInt(cells[cRoot]!);
    indexOf.set(id, i);
    rootId.push(id);
    const nt = cells[cNt]!;
    topNt.push(nt);
    if (nt === "gaba" || nt === "glutamate") sign.push(-1);
    else {
      if (!["acetylcholine", "dopamine", "serotonin", "octopamine"].includes(nt)) report.unknownTransmitter++;
      sign.push(1);
    }
    const superClass = cells[cSuper]!, cellClass = cells[cClass]!, type = cells[cType]!;
    cellType.push(type);
    if (cellClass === "Kenyon_Cell") add(i, "kc");
    if (cellClass === "MBON") add(i, "mbon");
    if (cellClass === "DAN") { add(i, "dan"); add(i, "neuromodulator"); }
    else if (nt === "octopamine") add(i, "neuromodulator");
    if (PERSISTENT_STATE_PREFIXES.some((p) => type.startsWith(p))) add(i, "persistent-state");
    if (superClass === "sensory" || cellClass === "ALPN") add(i, "sensory");
  }
  const N = indexOf.size;

  // Connections: sum syn_count over neuropils per (pre, post).
  compressionRegistry.set(CompressionType.ZSTD, { decode: (d: Uint8Array) => Bun.zstdDecompressSync(d) });
  const table = tableFromIPC(readFileSync(join(srcDir, CONNECTIONS)));
  const need = (name: string) => {
    const v = table.getChild(name);
    if (!v) throw new Error(`${CONNECTIONS} has no "${name}" column; found ${table.schema.fields.map((f) => f.name).join(", ")}`);
    return v;
  };
  const pre = need("pre_pt_root_id").toArray() as BigInt64Array;
  const post = need("post_pt_root_id").toArray() as BigInt64Array;
  const synRaw = need("syn_count").toArray() as ArrayLike<number | bigint>;
  const sum = new Map<number, number>(); // key = preIdx * N + postIdx, exact below 2^53
  for (let r = 0; r < pre.length; r++) {
    const a = indexOf.get(pre[r]!), b = indexOf.get(post[r]!);
    if (a === undefined || b === undefined) { report.droppedUnannotated++; continue; }
    const key = a * N + b;
    sum.set(key, (sum.get(key) ?? 0) + Number(synRaw[r]!));
  }

  // CSR, sorted by (pre, post).
  const keys = Float64Array.from(sum.keys()).sort();
  const rowPtr = new Int32Array(N + 1);
  const colIdxArr: number[] = [], weightArr: number[] = [];
  const kc = new Set(populations.kc ?? []);
  const mbon = populations.mbon ?? [];
  const dan = populations.dan ?? [];
  const pam = dan.filter((d) => cellType[d]!.startsWith("PAM"));
  const ppl1 = dan.filter((d) => cellType[d]!.startsWith("PPL1"));
  const compartmentOfMbon = new Map<number, number>();
  const compartments: Compartment[] = mbon.map((m, ci) => {
    compartmentOfMbon.set(m, ci);
    // Aso et al. 2014: glutamatergic MBONs drive avoidance, GABAergic and cholinergic ones approach.
    const mbonValence = topNt[m] === "glutamate" ? "avoidance" : "approach";
    const family = mbonValence === "avoidance" ? pam : ppl1;
    return { id: `${cellType[m]}:${rootId[m]}`, mbonValence, danIds: family.length ? family : dan };
  });
  if (compartments.length > 127) throw new Error(`plastic.bin stores compartments as Int8; ${compartments.length} do not fit`);
  const plasticEdgeIdx: number[] = [], plasticSrc: number[] = [], plasticComp: number[] = [];
  let row = 0;
  for (const key of keys) {
    const n = sum.get(key)!;
    if (n < floor) { report.belowFloor++; continue; }
    const a = Math.floor(key / N), b = key - a * N;
    while (row < a) rowPtr[++row] = colIdxArr.length;
    if (kc.has(a) && compartmentOfMbon.has(b)) {
      plasticEdgeIdx.push(colIdxArr.length);
      plasticSrc.push(a);
      plasticComp.push(compartmentOfMbon.get(b)!);
    }
    colIdxArr.push(b);
    weightArr.push(sign[a]! * n * wSyn);
  }
  while (row < N) rowPtr[++row] = colIdxArr.length;

  return {
    manifest: {
      packId: "flywire-783-v1",
      species: "Drosophila melanogaster (adult female)",
      source: { name: "FlyWire v783 (Dorkenwald et al. 2024) with Schlegel et al. 2024 annotations", doi: "10.1038/s41586-024-07558-y", release: `783, floor ${floor}` },
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

export const FLYWIRE_ATTRIBUTION = `# Attribution

This directory is a modified derivative of the FlyWire whole-brain connectome
of an adult female Drosophila melanogaster, release 783:

Dorkenwald, S., Matsliah, A., Sterling, A. R., et al. (2024). Neuronal wiring
diagram of an adult brain. Nature 634, 124-138. doi:10.1038/s41586-024-07558-y
Data: Zenodo 10676866, proofread_connections_783.feather. CC BY 4.0.

Schlegel, P., Yin, Y., Bates, A. S., et al. (2024). Whole-brain annotation and
multi-connectome cell typing of Drosophila. Nature 634, 139-152.
doi:10.1038/s41586-024-07686-5
Data: Supplemental_file1_neuron_annotations.tsv from
https://github.com/flyconnectome/flywire_annotations. CC BY 4.0.

Modifications made when building this pack:

- synapse floor ${FLYWIRE_SYNAPSE_FLOOR}: syn_count is summed over neuropils per connection and only
  connections with at least ${FLYWIRE_SYNAPSE_FLOOR} synapses are kept;
- connections with an endpoint absent from the annotations are dropped;
- sign from the presynaptic neuron's predicted transmitter (top_nt):
  acetylcholine, dopamine, serotonin, octopamine positive; GABA, glutamate
  negative; neurons with no prediction positive;
- weight = sign x synapse count x 0.275 mV (Shiu et al. 2024);
- roles: cell_class Kenyon_Cell -> kc, MBON -> mbon, DAN -> dan and
  neuromodulator, top_nt octopamine -> neuromodulator, cell_type EPG/PEN/PEG/
  Delta7 -> persistent-state, super_class sensory and cell_class ALPN -> sensory;
- MBON valence: glutamatergic -> avoidance, others -> approach (Aso et al. 2014);
  compartment DANs: PAM for avoidance compartments, PPL1 for approach.
`;
