/**
 * Variant 1, step G1: read-only audit of the antennal lobe in FlyWire 783.
 *
 * Measures, changes nothing: ALLN inventory per type and side, transmitter
 * label agreement (predicted top_nt vs literature known_nt), and a glomerulus
 * innervation proxy per ALLN from the glomerulus identity of its ORN inputs and
 * uniglomerular PN partners (FlyWire has no synapse-to-glomerulus table here).
 *
 *   bun src/brain-substrate/bench/al-audit.ts ../data/flywire > out.md
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CompressionType, compressionRegistry, tableFromIPC } from "apache-arrow";

const src = process.argv[2] ?? "../data/flywire";
const lines = readFileSync(join(src, "Supplemental_file1_neuron_annotations.tsv"), "utf8").split("\n");
const header = lines[0]!.replace(/\r$/, "").split("\t");
const c = (n: string) => header.indexOf(n);
type Cell = { type: string; cls: string; sub: string; side: string; top: string; known: string; conf: number };
const cells = new Map<bigint, Cell>();
for (const raw of lines.slice(1)) {
  const f = raw.replace(/\r$/, "").split("\t");
  if (f.length < header.length) continue;
  cells.set(BigInt(f[c("root_id")]!), {
    type: f[c("cell_type")]!, cls: f[c("cell_class")]!, sub: f[c("cell_sub_class")]!,
    side: f[c("side")]!, top: f[c("top_nt")]!, known: f[c("known_nt")]!, conf: Number(f[c("top_nt_conf")]),
  });
}

// Glomerulus of a neuron, when its type names one: ORN_DL5 -> DL5, DL5_adPN -> DL5 (uniglomerular only).
const glomOf = (x: Cell): string | null => {
  if (x.type.startsWith("ORN_")) return x.type.slice(4);
  if (x.cls === "ALPN" && x.sub === "uniglomerular" && x.type.includes("_")) return x.type.split("_")[0]!;
  return null;
};

compressionRegistry.set(CompressionType.ZSTD, { decode: (d: Uint8Array) => Bun.zstdDecompressSync(d) });
const t = tableFromIPC(readFileSync(join(src, "proofread_connections_783.feather")));
const pre = t.getChild("pre_pt_root_id")!.toArray() as BigInt64Array;
const post = t.getChild("post_pt_root_id")!.toArray() as BigInt64Array;
const syn = t.getChild("syn_count")!.toArray() as ArrayLike<number>;

// Per ALLN: synapses to/from each glomerulus-bearing partner class.
type Tally = { glom: Map<string, number>; toPN: number; fromORN: number; toORN: number; toLN: number; fromLN: number };
const tally = new Map<bigint, Tally>();
const get = (id: bigint) => { let v = tally.get(id); if (!v) tally.set(id, v = { glom: new Map(), toPN: 0, fromORN: 0, toORN: 0, toLN: 0, fromLN: 0 }); return v; };
for (let r = 0; r < pre.length; r++) {
  const a = cells.get(pre[r]!), b = cells.get(post[r]!);
  if (!a || !b) continue;
  const n = Number(syn[r]);
  if (a.cls === "ALLN") {
    const v = get(pre[r]!);
    if (b.cls === "ALPN" && b.sub === "uniglomerular") v.toPN += n;
    if (b.type.startsWith("ORN_")) v.toORN += n;
    if (b.cls === "ALLN") v.toLN += n;
    const g = glomOf(b); if (g) v.glom.set(g, (v.glom.get(g) ?? 0) + n);
  }
  if (b.cls === "ALLN") {
    const v = get(post[r]!);
    if (a.type.startsWith("ORN_")) v.fromORN += n;
    if (a.cls === "ALLN") v.fromLN += n;
    const g = glomOf(a); if (g) v.glom.set(g, (v.glom.get(g) ?? 0) + n);
  }
}

// Glomeruli "innervated": smallest set covering 80% of glomerulus-attributed synapses.
const breadth = (m: Map<string, number>) => {
  const s = [...m.values()].sort((x, y) => y - x), tot = s.reduce((p, q) => p + q, 0);
  let acc = 0, k = 0; for (const x of s) { if (acc >= 0.8 * tot) break; acc += x; k++; }
  return k;
};

const byType = new Map<string, bigint[]>();
for (const [id, x] of cells) if (x.cls === "ALLN") (byType.get(x.type || "(untyped)") ?? byType.set(x.type || "(untyped)", []).get(x.type || "(untyped)")!).push(id);

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
const count = (a: string[]) => Object.entries(a.reduce<Record<string, number>>((m, k) => (m[k] = (m[k] ?? 0) + 1, m), {})).map(([k, v]) => `${k || "-"}:${v}`).join(" ");

const out: string[] = [];
out.push(`# FlyWire 783 antennal lobe audit (G1), generated ${new Date().toISOString()}`, "");
const alln = [...cells.values()].filter((x) => x.cls === "ALLN");
out.push(`ALLNs: ${alln.length} in ${byType.size} types; sides ${count(alln.map((x) => x.side))}`);
const knownAny = alln.filter((x) => x.known);
const disagree = knownAny.filter((x) => !x.known.toLowerCase().includes(x.top.toLowerCase()));
out.push(`ALLNs with a literature known_nt: ${knownAny.length}; of those, top_nt NOT contained in known_nt: ${disagree.length}`, "");
out.push("| type | n | sides | top_nt | known_nt | median top_nt_conf | median glomeruli (80% syn) | median syn to uPN | to ORN | to LN | from ORN | from LN |");
out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const [type, ids] of [...byType].sort((p, q) => q[1].length - p[1].length)) {
  const xs = ids.map((i) => cells.get(i)!), ts = ids.map((i) => tally.get(i) ?? get(i));
  out.push(`| ${type} | ${ids.length} | ${count(xs.map((x) => x.side))} | ${count(xs.map((x) => x.top))} | ${count(xs.map((x) => x.known))} | ${med(xs.map((x) => x.conf)).toFixed(2)} | ${med(ts.map((v) => breadth(v.glom)))} | ${med(ts.map((v) => v.toPN))} | ${med(ts.map((v) => v.toORN))} | ${med(ts.map((v) => v.toLN))} | ${med(ts.map((v) => v.fromORN))} | ${med(ts.map((v) => v.fromLN))} |`);
}
const orn = new Set([...cells.values()].filter((x) => x.type.startsWith("ORN_")).map((x) => x.type.slice(4)));
const upn = new Set([...cells.values()].filter((x) => x.cls === "ALPN" && x.sub === "uniglomerular").map(glomOf).filter(Boolean) as string[]);
out.push("", `Glomeruli with FlyWire ORN types: ${orn.size}; with uniglomerular PN types: ${upn.size}; both: ${[...orn].filter((g) => upn.has(g)).length}`);
out.push(`ORN glomeruli: ${[...orn].sort().join(" ")}`);
console.log(out.join("\n"));
