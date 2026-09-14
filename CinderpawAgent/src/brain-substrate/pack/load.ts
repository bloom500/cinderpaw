/**
 * Loads and validates a brain pack directory. Every refusal is a PackError with
 * one plain sentence, because these reach the screen (Task 6).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./write.ts";
import {
  CSR_MAGIC,
  HEADER_BYTES,
  PLASTIC_MAGIC,
  PackError,
  ROLES,
  type BrainPack,
  type Manifest,
  type Role,
} from "./types.ts";

/** Copies file bytes into a fresh, 4-byte aligned ArrayBuffer (Node pools Buffers at odd offsets). */
function readAligned(path: string, file: string): Uint8Array {
  if (!existsSync(path)) throw new PackError(`The pack has no ${file}.`);
  const buf = readFileSync(path);
  const out = new Uint8Array(buf.length);
  out.set(buf);
  return out;
}

function checkHeader(bytes: Uint8Array, magic: string, file: string): DataView {
  if (bytes.length < HEADER_BYTES) throw new PackError(`${file} is too short to be a brain pack file.`);
  const got = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (got !== magic) throw new PackError(`${file} does not start with the ${magic} magic bytes.`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getInt32(4, true);
  if (version !== 1) throw new PackError(`${file} uses layout version ${version}; this build reads 1.`);
  return dv;
}

function need(bytes: Uint8Array, off: number, len: number, file: string): void {
  if (off + len > bytes.length) throw new PackError(`${file} is shorter than its header says.`);
}

export function loadPack(dir: string): BrainPack {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) throw new PackError(`No manifest.json in ${dir}; this is not a brain pack.`);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  } catch (err) {
    throw new PackError(`manifest.json in ${dir} is not valid JSON: ${(err as Error).message}.`);
  }
  if (manifest.packFormatVersion !== 1 || manifest.simulatorAbiVersion !== 1) {
    throw new PackError(
      `Pack ${manifest.packId} uses format ${manifest.packFormatVersion} and simulator ABI ${manifest.simulatorAbiVersion}; this pack needs a newer Cinderpaw.`,
    );
  }
  if (!manifest.attributionFile || !existsSync(join(dir, manifest.attributionFile))) {
    throw new PackError(
      `Pack ${manifest.packId} has no ${manifest.attributionFile || "ATTRIBUTION.md"}; a pack without attribution is refused.`,
    );
  }

  const csrBytes = readAligned(join(dir, "csr.bin"), "csr.bin");
  const csrSha256 = sha256(csrBytes);
  if (csrSha256 !== manifest.sha256?.["csr.bin"]) {
    throw new PackError("csr.bin does not match the sha256 in manifest.json; the pack is corrupt or was edited.");
  }
  const plasticBytes = readAligned(join(dir, "plastic.bin"), "plastic.bin");
  if (sha256(plasticBytes) !== manifest.sha256?.["plastic.bin"]) {
    throw new PackError("plastic.bin does not match the sha256 in manifest.json; the pack is corrupt or was edited.");
  }

  const N = manifest.neurons;
  const E = manifest.edges;
  const csrDv = checkHeader(csrBytes, CSR_MAGIC, "csr.bin");
  if (csrDv.getInt32(8, true) !== N || csrDv.getInt32(12, true) !== E) {
    throw new PackError(`csr.bin header counts disagree with manifest.json (neurons ${N}, edges ${E}).`);
  }
  let off = HEADER_BYTES;
  need(csrBytes, off, (N + 1) * 4 + E * 8, "csr.bin");
  const rowPtr = new Int32Array(csrBytes.buffer, off, N + 1);
  off += (N + 1) * 4;
  const colIdx = new Int32Array(csrBytes.buffer, off, E);
  off += E * 4;
  const weight = new Float32Array(csrBytes.buffer, off, E);

  const plDv = checkHeader(plasticBytes, PLASTIC_MAGIC, "plastic.bin");
  const P = plDv.getInt32(8, true);
  if (P !== manifest.plasticEdges) {
    throw new PackError(`plastic.bin holds ${P} plastic edges but manifest.json says ${manifest.plasticEdges}.`);
  }
  off = HEADER_BYTES;
  need(plasticBytes, off, P * 9, "plastic.bin");
  const edgeIdx = new Int32Array(plasticBytes.buffer, off, P);
  off += P * 4;
  const src = new Int32Array(plasticBytes.buffer, off, P);
  off += P * 4;
  const compartment = new Int8Array(plasticBytes.buffer, off, P);

  // Structure.
  if (rowPtr[0] !== 0) throw new PackError(`csr.bin rowPtr must start at 0, found ${rowPtr[0]}.`);
  for (let i = 1; i <= N; i++) {
    if (rowPtr[i]! < rowPtr[i - 1]!) throw new PackError(`csr.bin rowPtr decreases at neuron ${i}.`);
  }
  if (rowPtr[N] !== E) throw new PackError(`csr.bin rowPtr ends at ${rowPtr[N]} but the pack declares ${E} edges.`);
  for (let i = 0; i < E; i++) {
    const c = colIdx[i]!;
    if (c < 0 || c >= N) throw new PackError(`csr.bin edge ${i} points at neuron ${c}, outside the ${N} neurons.`);
  }
  const populations: Partial<Record<Role, Int32Array>> = {};
  for (const role of Object.keys(manifest.populations ?? {})) {
    if (!ROLES.includes(role as Role)) throw new PackError(`manifest.json names an unknown population role "${role}".`);
    const ids = manifest.populations[role as Role]!;
    for (const id of ids) {
      if (!Number.isInteger(id) || id < 0 || id >= N) {
        throw new PackError(`population "${role}" lists neuron ${id}, outside the ${N} neurons.`);
      }
    }
    populations[role as Role] = Int32Array.from(ids);
  }
  const compartments = manifest.compartments ?? [];
  for (const [ci, comp] of compartments.entries()) {
    for (const d of comp.danIds) {
      if (!Number.isInteger(d) || d < 0 || d >= N) {
        throw new PackError(`compartment ${ci} lists DAN ${d}, outside the ${N} neurons.`);
      }
    }
  }
  for (let i = 0; i < P; i++) {
    const e = edgeIdx[i]!;
    if (e < 0 || e >= E) throw new PackError(`plastic edge ${i} points at edge position ${e}, outside the ${E} edges.`);
    const s = src[i]!;
    if (s < 0 || s >= N) throw new PackError(`plastic edge ${i} names source neuron ${s}, outside the ${N} neurons.`);
    const c = compartment[i]!;
    if (c < 0 || c >= compartments.length) {
      throw new PackError(`plastic edge ${i} names compartment ${c}, but the pack has ${compartments.length} compartments.`);
    }
  }

  return { manifest, dir, csrSha256, rowPtr, colIdx, weight, plastic: { edgeIdx, src, compartment }, populations };
}
