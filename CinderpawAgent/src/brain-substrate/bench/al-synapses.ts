/**
 * Variant 1: which glomerulus each antennal-lobe synapse sits in.
 *
 * FlyWire gives synapse coordinates but no glomerulus per synapse, and the
 * patchy local neurons compute per glomerulus, so a synapse between two local
 * neurons needs a place. Reference points are ORN presynapses: an ORN_<g> axon
 * terminates only in glomerulus g, so its release sites label that territory.
 * Every other AL synapse gets the majority glomerulus of its K nearest ORN
 * presynapses. Held-out check, never used for assignment: synapses onto
 * uniglomerular PN dendrites from non-ORN partners must land in the PN's own
 * glomerulus.
 *
 * Streams the 9.5 GB table batch by batch (65,536 rows each), so memory holds
 * only the AL rows.
 *
 *   bun run src/brain-substrate/bench/al-synapses.ts --data ../data/flywire --out ../build/al-synapses-783
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CompressionType, compressionRegistry, RecordBatchReader, type RecordBatch } from "apache-arrow";

/**
 * The synapse table positions are already nm, unlike the 4 x 4 x 40 nm voxels of the
 * annotation file. Checked on the data: the kept AL synapses span 234 x 103 x 95 um as nm;
 * read as voxels the z span would be 3.8 mm, larger than the brain.
 */
export const MAX_AL_SPAN_UM = 400;
export const K = 10;
/** Grid cell for the neighbour search, nm. Only speed depends on it, not the answer. */
const CELL_NM = 2000;

/** Majority label among the k nearest reference points; ties go to the nearest of the tied labels. */
export function knnLabel(dists: number[], labels: number[]): { label: number; agree: number } {
  const order = dists.map((d, i) => [d, labels[i]!] as const).sort((a, b) => a[0] - b[0]);
  const votes = new Map<number, number>();
  for (const [, l] of order) votes.set(l, (votes.get(l) ?? 0) + 1);
  const best = Math.max(...votes.values());
  const label = order.find(([, l]) => votes.get(l) === best)![1];
  return { label, agree: best / order.length };
}

if (import.meta.main) {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const data = resolve(arg("data") ?? "../data/flywire"), out = resolve(arg("out") ?? "../build/al-synapses-783");
  mkdirSync(out, { recursive: true });

  // Cells of the antennal lobe.
  const lines = readFileSync(join(data, "Supplemental_file1_neuron_annotations.tsv"), "utf8").split("\n");
  const h = lines[0]!.replace(/\r$/, "").split("\t"); const col = (n: string) => h.indexOf(n);
  const rootToIdx = new Map<bigint, number>();
  const kind: string[] = [], type: string[] = [], glomNames: string[] = [], glomOfCell: number[] = [];
  const glomId = (g: string) => { let i = glomNames.indexOf(g); if (i < 0) { glomNames.push(g); i = glomNames.length - 1; } return i; };
  let n = 0;
  for (const raw of lines.slice(1)) {
    const f = raw.replace(/\r$/, "").split("\t");
    if (f.length < h.length) continue;
    const t = f[col("cell_type")]!, cls = f[col("cell_class")]!, sub = f[col("cell_sub_class")]!;
    const k = t.startsWith("ORN_") ? "ORN" : cls === "ALPN" ? (sub === "uniglomerular" ? "uPN" : "mPN") : cls === "ALLN" ? "LN" : "";
    rootToIdx.set(BigInt(f[col("root_id")]!), n);
    kind.push(k); type.push(t);
    glomOfCell.push(k === "ORN" ? glomId(t.slice(4)) : k === "uPN" && t.includes("_") ? -2 : -1);
    n++;
  }
  for (let i = 0; i < n; i++) if (glomOfCell[i] === -2) { const g = type[i]!.split("_")[0]!; glomOfCell[i] = glomNames.includes(g) ? glomNames.indexOf(g) : -1; }

  // Pass 1: keep AL synapses touching an AL cell. Cached.
  const cache = join(out, "al-rows.bin");
  let pre: Int32Array, post: Int32Array, xyz: Float32Array;
  if (existsSync(cache)) {
    const buf = readFileSync(cache); const m = buf.readUInt32LE(0);
    pre = new Int32Array(buf.buffer, buf.byteOffset + 4, m).slice();
    post = new Int32Array(buf.buffer, buf.byteOffset + 4 + 4 * m, m).slice();
    xyz = new Float32Array(buf.buffer, buf.byteOffset + 4 + 8 * m, 3 * m).slice();
    console.error(`cache: ${m} AL rows`);
  } else {
    compressionRegistry.set(CompressionType.ZSTD, { decode: (d: Uint8Array) => Bun.zstdDecompressSync(d) });
    const reader = (await RecordBatchReader.from((await open(join(data, "flywire_synapses_783.feather"))) as never)) as unknown as AsyncIterable<RecordBatch> & { open(): Promise<unknown> };
    await reader.open();
    const P: number[] = [], Q: number[] = [], X: number[] = [];
    let batches = 0, rows = 0; const t0 = Date.now();
    for await (const b of reader) {
      const pr = b.getChild("pre_pt_root_id")!.toArray() as BigInt64Array, po = b.getChild("post_pt_root_id")!.toArray() as BigInt64Array;
      const np = b.getChild("neuropil")!;
      const px = b.getChild("pre_pt_position_x")!.toArray() as BigInt64Array, py = b.getChild("pre_pt_position_y")!.toArray() as BigInt64Array, pz = b.getChild("pre_pt_position_z")!.toArray() as BigInt64Array;
      const qx = b.getChild("post_pt_position_x")!.toArray() as BigInt64Array, qy = b.getChild("post_pt_position_y")!.toArray() as BigInt64Array, qz = b.getChild("post_pt_position_z")!.toArray() as BigInt64Array;
      for (let r = 0; r < b.numRows; r++) {
        const a = rootToIdx.get(pr[r]!), c = rootToIdx.get(po[r]!);
        if (a === undefined || c === undefined || (!kind[a] && !kind[c])) continue;
        const neuropil = np.get(r) as string | null;
        if (!neuropil || !neuropil.startsWith("AL_")) continue;
        P.push(a); Q.push(c);
        // The synapse site: midpoint of the pre and post points, in nm.
        X.push((Number(px[r]) + Number(qx[r])) / 2, (Number(py[r]) + Number(qy[r])) / 2, (Number(pz[r]) + Number(qz[r])) / 2);
      }
      rows += b.numRows;
      if (++batches % 100 === 0) console.error(`batch ${batches}, ${(rows / 1e6).toFixed(0)}M rows read, ${P.length} kept, ${((Date.now() - t0) / 1000).toFixed(0)} s, rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
    }
    pre = Int32Array.from(P); post = Int32Array.from(Q); xyz = Float32Array.from(X);
    const head = Buffer.alloc(4); head.writeUInt32LE(pre.length, 0);
    writeFileSync(cache, Buffer.concat([head, Buffer.from(pre.buffer), Buffer.from(post.buffer), Buffer.from(xyz.buffer)]));
    console.error(`pass 1 done: ${rows} rows, ${pre.length} AL rows kept`);
  }
  const m = pre.length;
  for (let a = 0; a < 3; a++) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < m; i++) { const v = xyz[3 * i + a]!; if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = (hi - lo) / 1000;
    console.error(`axis ${a}: span ${span.toFixed(0)} um`);
    if (span > MAX_AL_SPAN_UM) throw new Error(`AL synapses span ${span.toFixed(0)} um on axis ${a}: coordinate units are wrong`);
  }

  // Reference points: ORN presynapses, labelled by the ORN's glomerulus, in a spatial hash.
  const key = (x: number, y: number, z: number) => `${Math.floor(x / CELL_NM)},${Math.floor(y / CELL_NM)},${Math.floor(z / CELL_NM)}`;
  const grid = new Map<string, number[]>();
  let refs = 0;
  for (let i = 0; i < m; i++) {
    if (kind[pre[i]!] !== "ORN") continue;
    const k = key(xyz[3 * i]!, xyz[3 * i + 1]!, xyz[3 * i + 2]!);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    refs++;
  }
  const nearest = (i: number, exclude: number) => {
    const x = xyz[3 * i]!, y = xyz[3 * i + 1]!, z = xyz[3 * i + 2]!;
    const cx = Math.floor(x / CELL_NM), cy = Math.floor(y / CELL_NM), cz = Math.floor(z / CELL_NM);
    for (let rad = 1; rad <= 6; rad++) {
      const d: number[] = [], l: number[] = [];
      for (let a = -rad; a <= rad; a++) for (let b = -rad; b <= rad; b++) for (let c = -rad; c <= rad; c++) {
        for (const j of grid.get(`${cx + a},${cy + b},${cz + c}`) ?? []) {
          if (pre[j] === exclude) continue;
          d.push(Math.hypot(xyz[3 * j]! - x, xyz[3 * j + 1]! - y, xyz[3 * j + 2]! - z)); l.push(glomOfCell[pre[j]!]!);
        }
      }
      // Enough neighbours AND the k-th is inside the searched radius, so no closer point was missed.
      if (d.length >= K) {
        const idx = d.map((_, q) => q).sort((p, q) => d[p]! - d[q]!).slice(0, K);
        if (d[idx[K - 1]!]! <= rad * CELL_NM) return { ...knnLabel(idx.map((q) => d[q]!), idx.map((q) => l[q]!)), dist: d[idx[0]!]! };
      }
    }
    return null;
  };

  // Held-out check: non-ORN synapses onto uniglomerular PNs with a known glomerulus.
  let hoN = 0, hoOk = 0, hoNone = 0;
  for (let i = 0; i < m; i++) {
    if (kind[post[i]!] !== "uPN" || glomOfCell[post[i]!]! < 0 || kind[pre[i]!] === "ORN") continue;
    if (i % 7 !== 0) continue; // ponytail: every 7th such synapse is plenty for an accuracy estimate
    const r = nearest(i, -1);
    if (!r) { hoNone++; continue; }
    hoN++; if (r.label === glomOfCell[post[i]!]) hoOk++;
  }

  // Assignment of every synapse with a local neuron on either side.
  const G = glomNames.length;
  const edges = new Map<string, number>();
  const lnIn = new Map<number, Float64Array>(), lnOut = new Map<number, Float64Array>();
  let assigned = 0, unassigned = 0, lowAgree = 0;
  for (let i = 0; i < m; i++) {
    const a = pre[i]!, c = post[i]!;
    if (kind[a] !== "LN" && kind[c] !== "LN") continue;
    if ((assigned + unassigned) % 100000 === 0) console.error(`assigning: ${assigned + unassigned} local-neuron synapses done`);
    const r = nearest(i, -1);
    if (!r) { unassigned++; continue; }
    assigned++; if (r.agree < 0.6) lowAgree++;
    const ek = `${a},${c},${r.label}`; edges.set(ek, (edges.get(ek) ?? 0) + 1);
    if (kind[c] === "LN") (lnIn.get(c) ?? lnIn.set(c, new Float64Array(G)).get(c)!)[r.label]! += 1;
    if (kind[a] === "LN") (lnOut.get(a) ?? lnOut.set(a, new Float64Array(G)).get(a)!)[r.label]! += 1;
  }

  writeFileSync(join(out, "glomeruli.json"), JSON.stringify(glomNames));
  writeFileSync(join(out, "ln-edges-by-glomerulus.tsv"), ["pre_idx\tpost_idx\tglomerulus\tsynapses", ...[...edges].map(([k, v]) => { const [p, q, g] = k.split(","); return `${p}\t${q}\t${glomNames[Number(g)]}\t${v}`; })].join("\n"));
  const summary = [
    `# Antennal-lobe synapses by glomerulus (FlyWire 783), ${new Date().toISOString()}`,
    ``,
    `AL rows kept: ${m}; ORN presynapse reference points: ${refs}; glomeruli: ${G}; K = ${K}.`,
    `Held-out check (every 7th non-ORN synapse onto a uniglomerular PN of known glomerulus): ${hoN} scored, accuracy ${(hoOk / Math.max(hoN, 1)).toFixed(3)}, ${hoNone} with no reference within reach.`,
    `Local-neuron synapses: ${assigned} assigned, ${unassigned} unassigned (no ${K} references within ${6 * CELL_NM / 1000} um), ${lowAgree} with neighbour agreement < 0.6.`,
    `Distinct (pre, post, glomerulus) local-neuron edges: ${edges.size}. Local neurons with inputs: ${lnIn.size}, with outputs: ${lnOut.size}.`,
    ``,
  ].join("\n");
  writeFileSync(join(out, "SUMMARY.md"), summary);
  console.log(summary);
}
