/**
 * Writes a brain pack directory. Runs at build time (scripts/brain/build-pack.ts)
 * and in tests; never on a user's machine.
 *
 * Binary layout, little-endian (typed arrays are native-endian, and every
 * platform Cinderpaw ships on is little-endian):
 *   csr.bin     = header [magic "CBRC", version 1, N, E] as 4 x Int32,
 *                 then rowPtr Int32[N+1], colIdx Int32[E], weight Float32[E]
 *   plastic.bin = header [magic "CBRP", 1, P, 0],
 *                 then edgeIdx Int32[P], src Int32[P], compartment Int8[P] padded to 4 bytes
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CSR_MAGIC, HEADER_BYTES, PLASTIC_MAGIC, type Manifest, type PackFiles } from "./types.ts";

function header(magic: string, a: number, b: number): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES);
  for (let i = 0; i < 4; i++) out[i] = magic.charCodeAt(i);
  const dv = new DataView(out.buffer);
  dv.setInt32(4, 1, true);
  dv.setInt32(8, a, true);
  dv.setInt32(12, b, true);
  return out;
}

/** Copies each array's bytes back to back, padding the total to a 4-byte boundary. */
function concat(parts: ArrayBufferView[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array((total + 3) & ~3);
  let off = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), off);
    off += p.byteLength;
  }
  return out;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function encodeCsr(f: PackFiles): Uint8Array {
  return concat([header(CSR_MAGIC, f.manifest.neurons, f.manifest.edges), f.rowPtr, f.colIdx, f.weight]);
}

export function encodePlastic(f: PackFiles): Uint8Array {
  const p = f.plastic;
  return concat([header(PLASTIC_MAGIC, p.edgeIdx.length, 0), p.edgeIdx, p.src, p.compartment]);
}

export function writePackFiles(dir: string, files: PackFiles): Manifest {
  mkdirSync(resolve(dir), { recursive: true }); // Bun 1.3 on Windows: EEXIST on an existing relative ".." path
  const csr = encodeCsr(files);
  const plastic = encodePlastic(files);
  writeFileSync(join(dir, "csr.bin"), csr);
  writeFileSync(join(dir, "plastic.bin"), plastic);
  const manifest: Manifest = {
    ...files.manifest,
    sha256: { "csr.bin": sha256(csr), "plastic.bin": sha256(plastic) },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
