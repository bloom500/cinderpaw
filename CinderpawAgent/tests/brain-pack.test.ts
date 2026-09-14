// tests/brain-pack.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPack } from "../src/brain-substrate/pack/load.ts";
import { writePackFiles } from "../src/brain-substrate/pack/write.ts";
import { readLearnedState, writeLearnedState } from "../src/brain-substrate/pack/learned-state.ts";
import { SHIU_2024, type PackFiles } from "../src/brain-substrate/pack/types.ts";

const LARVA = join(import.meta.dir, "fixtures/brain/larva");

/** A 4-neuron pack: 0 (sensory) -> 1 (kc) -> 2 (mbon), 3 (dan). */
function tinyFiles(): PackFiles {
  return {
    manifest: {
      packId: "tiny-v1", species: "test", source: { name: "hand", doi: "", release: "" },
      completeness: "region", packFormatVersion: 1, simulatorAbiVersion: 1,
      license: "CC-BY-4.0", attributionFile: "ATTRIBUTION.md",
      neurons: 4, edges: 2, plasticEdges: 1, simParams: SHIU_2024, seed: 7,
      populations: { sensory: [0], kc: [1], mbon: [2], dan: [3] },
      compartments: [{ id: "c0", mbonValence: "approach", danIds: [3] }],
      plasticity: { rule: "kc-mbon-depression-v1", eta: 0.1, maxDelta: null },
    },
    rowPtr: Int32Array.from([0, 1, 2, 2, 2]),
    colIdx: Int32Array.from([1, 2]),
    weight: Float32Array.from([5 * 0.275, 8 * 0.275]),
    plastic: { edgeIdx: Int32Array.from([1]), src: Int32Array.from([1]), compartment: Int8Array.from([0]) },
  };
}

describe("brain pack", () => {
  test("round-trips a hand-built pack", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    writeFileSync(join(dir, "ATTRIBUTION.md"), "hand-built\n");
    writePackFiles(dir, tinyFiles());
    const pack = loadPack(dir);
    expect(pack.manifest.neurons).toBe(4);
    expect(Array.from(pack.colIdx)).toEqual([1, 2]);
    expect(pack.weight[1]).toBeCloseTo(8 * 0.275, 5);
    expect(Array.from(pack.populations.kc!)).toEqual([1]);
    expect(Array.from(pack.plastic.edgeIdx)).toEqual([1]);
  });

  test("a single flipped byte in csr.bin is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    writeFileSync(join(dir, "ATTRIBUTION.md"), "x\n");
    writePackFiles(dir, tinyFiles());
    const buf = readFileSync(join(dir, "csr.bin"));
    buf[buf.length - 1] ^= 0xff;
    writeFileSync(join(dir, "csr.bin"), buf);
    expect(() => loadPack(dir)).toThrow(/sha256/);
  });

  test("a pack without an attribution file is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    writePackFiles(dir, tinyFiles());
    expect(() => loadPack(dir)).toThrow(/ATTRIBUTION/);
  });

  test("structural validation: row pointers, indices, populations, plastic positions", () => {
    const bad = tinyFiles();
    bad.plastic.edgeIdx = Int32Array.from([9]);
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    writeFileSync(join(dir, "ATTRIBUTION.md"), "x\n");
    writePackFiles(dir, bad);
    expect(() => loadPack(dir)).toThrow(/plastic/);
  });

  test("the larva fixture loads with the roles the spec names, and no persistent-state", () => {
    const pack = loadPack(LARVA);
    expect(pack.manifest.species).toBe("Drosophila melanogaster (L1 larva)");
    expect(pack.manifest.neurons).toBeGreaterThan(2500);
    expect(pack.rowPtr.length).toBe(pack.manifest.neurons + 1);
    expect(pack.rowPtr[pack.manifest.neurons]).toBe(pack.manifest.edges);
    for (const role of ["sensory", "kc", "mbon", "dan", "neuromodulator"] as const) {
      expect(pack.populations[role]!.length).toBeGreaterThan(0);
    }
    expect(pack.populations["persistent-state"]).toBeUndefined();
    // Every plastic edge really is KC -> MBON.
    const kc = new Set(pack.populations.kc!), mbon = new Set(pack.populations.mbon!);
    for (let i = 0; i < pack.plastic.edgeIdx.length; i++) {
      expect(kc.has(pack.plastic.src[i]!)).toBe(true);
      expect(mbon.has(pack.colIdx[pack.plastic.edgeIdx[i]!]!)).toBe(true);
    }
  });

  test("learned state is bound to the pack hash and the schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    writeFileSync(join(dir, "ATTRIBUTION.md"), "x\n");
    writePackFiles(dir, tinyFiles());
    const pack = loadPack(dir);
    const state = mkdtempSync(join(tmpdir(), "state-"));
    writeLearnedState(state, pack, Float32Array.from([-0.1]));
    const ok = readLearnedState(state, pack);
    expect("delta" in ok && ok.delta[0]).toBeCloseTo(-0.1, 6);
    // Same id, different topology: refused, file untouched.
    const other = { ...pack, csrSha256: "0".repeat(64) };
    const refused = readLearnedState(state, other);
    expect("refused" in refused && refused.refused).toMatch(/different connectome/);
    expect(readFileSync(join(state, "learned_delta.bin")).length).toBe(4);
  });
});
