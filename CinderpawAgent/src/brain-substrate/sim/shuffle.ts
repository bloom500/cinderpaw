/**
 * The control condition (spec section 7): the same neurons, the same number
 * of edges in and out of each of them, the same signs and per-row weights,
 * but who talks to whom is random. If the real wiring cannot beat this, the
 * connectome is not doing the work.
 */
import { mulberry32 } from "../../memory/fractal/prng.ts";
import type { BrainPack } from "../pack/types.ts";

const FIX_PASSES = 10;

export function degreeSignPreservingShuffle(pack: BrainPack, seed: number): BrainPack {
  const rand = mulberry32(seed);
  const N = pack.manifest.neurons;
  const E = pack.colIdx.length;
  const src = new Int32Array(E);
  for (let i = 0; i < N; i++) for (let e = pack.rowPtr[i]!; e < pack.rowPtr[i + 1]!; e++) src[e] = i;
  const tgt = new Int32Array(E);

  // Shuffle targets within each (sign, plastic) group: every in-degree and out-degree per sign survives,
  // and KC->MBON edges are permuted among themselves so the control has exactly as many learnable edges.
  const isPlastic = new Uint8Array(E);
  for (const e of pack.plastic.edgeIdx) isPlastic[e] = 1;
  const groups = new Map<number, number[]>();
  for (let e = 0; e < E; e++) {
    const sg = Math.sign(pack.weight[e]!) * 2 + isPlastic[e]!;
    let g = groups.get(sg);
    if (!g) groups.set(sg, (g = []));
    g.push(e);
  }
  let leftovers = 0;
  for (const members of groups.values()) {
    const targets = members.map((e) => pack.colIdx[e]!);
    for (let i = targets.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [targets[i], targets[j]] = [targets[j]!, targets[i]!];
    }
    const key = (i: number) => src[members[i]!]! * N + targets[i]!;
    const bad = (i: number, seen: Set<number>) => src[members[i]!] === targets[i] || seen.has(key(i));
    // Self-loops and duplicate pairs are swapped with a random later position; rare leftovers are counted, not hidden.
    for (let pass = 0; pass < FIX_PASSES; pass++) {
      const seen = new Set<number>();
      let fixed = 0;
      for (let i = 0; i < targets.length; i++) {
        if (bad(i, seen) && i + 1 < targets.length) {
          const j = i + 1 + Math.floor(rand() * (targets.length - i - 1));
          [targets[i], targets[j]] = [targets[j]!, targets[i]!];
          fixed++;
        }
        seen.add(key(i));
      }
      if (fixed === 0) break;
    }
    const seen = new Set<number>();
    for (let i = 0; i < targets.length; i++) {
      if (bad(i, seen)) leftovers++;
      seen.add(key(i));
      tgt[members[i]!] = targets[i]!;
    }
  }

  // Rebuild CSR; each weight stays on its source row.
  const order = Array.from({ length: E }, (_, e) => e).sort((a, b) => src[a]! - src[b]! || tgt[a]! - tgt[b]!);
  const rowPtr = new Int32Array(N + 1);
  const colIdx = new Int32Array(E);
  const weight = new Float32Array(E);
  order.forEach((e, k) => {
    rowPtr[src[e]! + 1] = rowPtr[src[e]! + 1]! + 1;
    colIdx[k] = tgt[e]!;
    weight[k] = pack.weight[e]!;
  });
  for (let i = 0; i < N; i++) rowPtr[i + 1] = rowPtr[i + 1]! + rowPtr[i]!;

  // Plastic edges are the KC->MBON positions of the new wiring; each MBON's compartment is read off the old list.
  const compartmentOfMbon = new Map<number, number>();
  for (let i = 0; i < pack.plastic.edgeIdx.length; i++) {
    compartmentOfMbon.set(pack.colIdx[pack.plastic.edgeIdx[i]!]!, pack.plastic.compartment[i]!);
  }
  const kc = new Set(pack.populations.kc ?? []);
  const edgeIdx: number[] = [], pSrc: number[] = [], pComp: number[] = [];
  for (let i = 0; i < N; i++) {
    if (!kc.has(i)) continue;
    for (let e = rowPtr[i]!; e < rowPtr[i + 1]!; e++) {
      const c = compartmentOfMbon.get(colIdx[e]!);
      if (c !== undefined) {
        edgeIdx.push(e);
        pSrc.push(i);
        pComp.push(c);
      }
    }
  }

  return {
    manifest: {
      ...pack.manifest,
      plasticEdges: edgeIdx.length,
      source: { ...pack.manifest.source, release: `shuffled seed=${seed} leftovers=${leftovers}` },
    },
    dir: "",
    csrSha256: `shuffled:${seed}`,
    rowPtr,
    colIdx,
    weight,
    plastic: { edgeIdx: Int32Array.from(edgeIdx), src: Int32Array.from(pSrc), compartment: Int8Array.from(pComp) },
    populations: pack.populations,
  };
}
