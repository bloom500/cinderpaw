/**
 * L4 module lexical wall (spec §4) — static rejection of module sources
 * that reach for ambient authority. Same fail-loud philosophy as the L3
 * CodeGenome policy wall: crude on purpose, over-rejection is fine,
 * under-rejection is not. This is defense-in-depth on top of the process
 * boundary (scrubbed env, no permissions) — Bun cannot fully sandbox
 * in-process code, so the wall keeps the obvious escape hatches out of
 * the source before it is ever imported.
 *
 * Rules (v1, spec §4):
 *   - imports: ONLY `node:assert` (pure). Every other specifier —
 *     node:*, bun:*, npm packages, relative files — is rejected
 *     (modules are single-file, stdlib-pure by contract).
 *   - banned tokens anywhere: fetch, process, require, eval, Bun,
 *     Function constructor, dynamic import().
 */

const ALLOWED_IMPORTS = new Set(["node:assert"]);

/** import/export-from specifiers, plus side-effect imports. */
const SPECIFIER_RE =
  /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'"\n;]*?from\s*)?["']([^"']+)["']/g;

/** Ambient-authority tokens. Word-bounded; comments and strings count too
 *  (a lexical wall does not parse — a module that merely MENTIONS process
 *  is rejected, and that is the intended strictness). */
const BANNED_TOKENS: Array<{ re: RegExp; name: string }> = [
  { re: /\bfetch\b/, name: "fetch" },
  { re: /\bprocess\b/, name: "process" },
  { re: /\brequire\b/, name: "require" },
  { re: /\beval\b/, name: "eval" },
  { re: /\bBun\b/, name: "Bun" },
  { re: /\bnew\s+Function\b|\bFunction\s*\(/, name: "Function constructor" },
  { re: /\bimport\s*\(/, name: "dynamic import()" },
];

export type WallResult = { ok: true } | { ok: false; reason: string };

/** Check one module source against the wall. First violation wins. */
export function wallCheck(source: string): WallResult {
  for (const match of source.matchAll(SPECIFIER_RE)) {
    const spec = match[1]!;
    if (!ALLOWED_IMPORTS.has(spec)) {
      return { ok: false, reason: `forbidden import: ${JSON.stringify(spec)} (allowed: ${[...ALLOWED_IMPORTS].join(", ")})` };
    }
  }
  for (const { re, name } of BANNED_TOKENS) {
    if (re.test(source)) {
      return { ok: false, reason: `forbidden token: ${name}` };
    }
  }
  return { ok: true };
}
