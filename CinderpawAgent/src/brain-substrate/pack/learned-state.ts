/**
 * Learned state lives beside the pack, never inside it (spec section 2.2):
 *   <stateDir>/learned_delta.bin  raw Float32, parallel to plastic.bin's edgeIdx
 *   <stateDir>/meta.json          { packSha256, plasticitySchemaVersion, updatedAt }
 *
 * A mismatch refuses to load and leaves the files untouched; only "Reset brain"
 * (elsewhere) ever deletes them. The refusal string is what the user sees.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../atomic-write.ts";
import type { BrainPack } from "./types.ts";

export const PLASTICITY_SCHEMA_VERSION = 1;

export interface LearnedMeta {
  packSha256: string;
  plasticitySchemaVersion: 1;
  updatedAt: number;
}

export function readLearnedState(
  stateDir: string,
  pack: BrainPack,
): { delta: Float32Array; meta: LearnedMeta } | { refused: string } {
  const metaPath = join(stateDir, "meta.json");
  const deltaPath = join(stateDir, "learned_delta.bin");
  if (!existsSync(metaPath) || !existsSync(deltaPath)) return { refused: "no learned state yet" };
  let meta: LearnedMeta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8")) as LearnedMeta;
  } catch {
    return { refused: "learned state meta.json is unreadable" };
  }
  if (meta.plasticitySchemaVersion !== PLASTICITY_SCHEMA_VERSION) {
    return {
      refused: `learned state uses plasticity schema ${meta.plasticitySchemaVersion}, this build reads ${PLASTICITY_SCHEMA_VERSION}`,
    };
  }
  if (meta.packSha256 !== pack.csrSha256) {
    return {
      refused: `learned state belongs to a different connectome (${String(meta.packSha256).slice(0, 12)}, this pack is ${pack.csrSha256.slice(0, 12)})`,
    };
  }
  const buf = readFileSync(deltaPath);
  const P = pack.plastic.edgeIdx.length;
  if (buf.length !== P * 4) {
    return { refused: `learned state holds ${buf.length / 4} deltas but the pack has ${P} plastic edges` };
  }
  const delta = new Float32Array(P);
  new Uint8Array(delta.buffer).set(buf);
  return { delta, meta };
}

export function writeLearnedState(stateDir: string, pack: BrainPack, delta: Float32Array): void {
  const P = pack.plastic.edgeIdx.length;
  if (delta.length !== P) throw new Error(`learned delta has ${delta.length} entries but the pack has ${P} plastic edges`);
  const meta: LearnedMeta = {
    packSha256: pack.csrSha256,
    plasticitySchemaVersion: PLASTICITY_SCHEMA_VERSION,
    updatedAt: Date.now(),
  };
  atomicWriteFileSync(join(stateDir, "learned_delta.bin"), new Uint8Array(delta.buffer, delta.byteOffset, delta.byteLength));
  atomicWriteFileSync(join(stateDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
}
