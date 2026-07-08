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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

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

/** Plain `sha256(canonical(value))` — the document hash approvals are
 *  recorded against (L5 spec §10: approve a hash, not an id). */
export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** The `hash` of the last row in a chained JSONL file, or GENESIS for a
 *  missing/empty file. Throws on an unreadable/unchained tail — chained
 *  governance files are never legacy (unlike the journal). */
export function lastHashOf(path: string): string {
  if (!existsSync(path)) return GENESIS;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last) return GENESIS;
  const row = JSON.parse(last) as { hash?: unknown };
  if (typeof row.hash !== "string") throw new Error(`unchained tail row in ${path}`);
  return row.hash;
}

/** Append one row to a chained JSONL file, filling `prevHash`/`hash`.
 *  Fails LOUD (throws): governance history must never be silently lost
 *  (L5 standing rule — fail loud, unlike the best-effort journal). */
export function appendChained<T extends Record<string, unknown>>(
  path: string,
  row: T,
): T & { prevHash: string; hash: string } {
  mkdirSync(dirname(path), { recursive: true });
  const { prevHash: _p, hash: _h, ...body } = row;
  const prevHash = lastHashOf(path);
  const hash = chainHash(prevHash, body);
  const full = { ...body, prevHash, hash } as T & { prevHash: string; hash: string };
  appendFileSync(path, JSON.stringify(full) + "\n", "utf8");
  return full;
}

export type ChainVerifyResult =
  | { ok: true; rows: number }
  | { ok: false; badRow: number; reason: string };

/** Walk a chained JSONL file end to end. No legacy allowance: every row
 *  must be chained (these files are born chained). Never throws. */
export function verifyChainFile(path: string): ChainVerifyResult {
  if (!existsSync(path)) return { ok: true, rows: 0 };
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0);
  } catch (err) {
    return { ok: false, badRow: 0, reason: `unreadable: ${String(err)}` };
  }
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const badRow = i + 1;
    let row: Record<string, unknown>;
    try {
      const parsed = JSON.parse(lines[i]!) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("not an object");
      row = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, badRow, reason: "malformed row" };
    }
    if (typeof row.hash !== "string") return { ok: false, badRow, reason: "missing hash" };
    if (row.prevHash !== prev) {
      return { ok: false, badRow, reason: "prevHash linkage broken (row deleted or reordered)" };
    }
    const { prevHash: _p, hash, ...body } = row;
    if (chainHash(prev, body) !== hash) {
      return { ok: false, badRow, reason: "hash mismatch (row content altered)" };
    }
    prev = hash as string;
  }
  return { ok: true, rows: lines.length };
}
