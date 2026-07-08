/**
 * Hash-chain primitives shared by the tamper-evident JSONL trails
 * (journal, L5 policy history). Mirrors the discipline of
 * `sandbox/audit-log.ts:47-52` and `src-tauri/src/rsi/audit.rs`:
 * `sha256(prevHash || 0x02 || canonical(row))`, genesis "GENESIS",
 * chain marker 0x02 — identical across TS and Rust so cross-language
 * auditors can walk both (L5 spec §11).
 *
 * Canonical form here is recursively-key-sorted JSON (not the fixed
 * field list audit-log uses) because these rows are heterogeneous
 * documents; sorted-key JSON is reproducible in any language.
 */

import { createHash } from "node:crypto";

/** Anchor for the first link in a chain. */
export const GENESIS = "GENESIS";

/** Deterministic JSON: object keys sorted recursively at every level.
 *  Arrays keep their order. `undefined` values are dropped (same as
 *  JSON.stringify). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key]);
    return out;
  }
  return value;
}

/** `sha256(prevHash || 0x02 || canonical(row))` as lowercase hex. */
export function chainHash(prevHash: string, row: unknown): string {
  return createHash("sha256")
    .update(prevHash)
    .update("\x02")
    .update(canonicalJson(row))
    .digest("hex");
}
