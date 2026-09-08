#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0 - see root LICENSE.
/**
 * check-license-boundary.mjs — enforce the split-license boundary.
 *
 * BSL paths (see root LICENSE table; matching is by path PREFIX, so any new
 * file created under them is automatically BSL):
 *   CinderpawAgent/src/rsi/
 *   CinderpawAgent/src/memory/fractal/
 *
 * Scanned: every .ts file under CinderpawAgent/src/ outside the BSL paths,
 * Apache-licensed helper scripts. tests/ is deliberately EXCLUDED: BSL-side
 * tests run in the full tree and may import anything.
 *
 * Rules:
 *   - value import (import/export-from/dynamic import()/require()) of a BSL
 *     path from an Apache file                      → FAIL, except allowlist
 *   - `import type` of a BSL path (erased at build)  → WARNING + count, exit 0
 *
 * Value-import allowlist (wiring only — boot wires the stack, dispatch is
 * the message switch; both jobs REQUIRE touching BSL):
 *   CinderpawAgent/src/boot.ts
 *   CinderpawAgent/src/dispatch.ts
 *
 * Usage: node scripts/check-license-boundary.mjs   (exit 0 clean, 1 violation)
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ROOT_FWD = ROOT.split(sep).join("/");
const AGENT = join(ROOT, "CinderpawAgent");

const BSL_PREFIXES = [
  "CinderpawAgent/src/rsi/",
  "CinderpawAgent/src/memory/fractal/",
];
const VALUE_ALLOWLIST = new Set([
  "CinderpawAgent/src/boot.ts",
  "CinderpawAgent/src/dispatch.ts",
]);
const APACHE_SCRIPTS = [
  "scripts/check-api-docs.mjs",
  "scripts/check-doc-links.ts",
  "scripts/check-env-docs.mjs",
  "scripts/check-invariant-coverage.ts",
  "scripts/gen-config-docs.mjs",
  "scripts/verify.sh",
  "scripts/verify.ps1",
];

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
      walk(p, out);
    } else if (e.isFile() && (p.endsWith(".ts") || p.endsWith(".mjs") || p.endsWith(".sh") || p.endsWith(".ps1"))) {
      out.push(p);
    }
  }
  return out;
}

function toFwd(p) {
  return p.split(sep).join("/");
}

function repoRel(absPath) {
  const fwd = toFwd(absPath);
  return fwd.startsWith(ROOT_FWD + "/") ? fwd.slice(ROOT_FWD.length + 1) : null;
}

/** Resolve a relative specifier against the importing file → repo-rel path (or null). */
function resolveSpec(fromAbs, spec) {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const parts = toFwd(join(dirname(fromAbs), spec)).split("/");
  const stack = [];
  for (const seg of parts) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") stack.pop();
    else stack.push(seg);
  }
  const fwd = stack.join("/");
  return fwd.startsWith(ROOT_FWD + "/") ? fwd.slice(ROOT_FWD.length + 1) : null;
}

function isBslPath(rel) {
  return BSL_PREFIXES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p));
}

// Scan set: src tree minus BSL paths, plus the Apache scripts.
const files = [];
walk(join(AGENT, "src"), files);
for (const s of APACHE_SCRIPTS) files.push(join(ROOT, s));
const inScope = files.filter((f) => {
  const rel = repoRel(f);
  if (!rel) return false;
  if (BSL_PREFIXES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p))) return false;
  if (rel.startsWith("CinderpawAgent/src/")) return true;
  return APACHE_SCRIPTS.includes(rel);
});

// import ... from "x" | export ... from "x" | import("x") | require("x")
const SPEC_RE = /(?:import|export)[^;"']*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

const fails = [];
const warns = [];
for (const file of inScope) {
  const rel = repoRel(file);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const [i, line] of text.split("\n").entries()) {
    SPEC_RE.lastIndex = 0;
    let m;
    while ((m = SPEC_RE.exec(line)) !== null) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      const target = resolveSpec(file, spec);
      if (!target || !isBslPath(target)) continue;
      const entry = `${rel}:${i + 1}: ${spec}`;
      if (/^\s*import\s+type\b/.test(line)) warns.push(entry);
      else fails.push(entry);
    }
  }
}

const violations = fails.filter((f) => ![...VALUE_ALLOWLIST].some((a) => f.startsWith(a + ":")));
const allowlisted = fails.filter((f) => [...VALUE_ALLOWLIST].some((a) => f.startsWith(a + ":")));

if (warns.length > 0) {
  console.log(`[license-boundary] WARNING: ${warns.length} type-only import(s) of BSL paths (erased at build, tracked for surface):`);
  for (const w of warns) console.log(`  type-only  ${w}`);
}
if (allowlisted.length > 0) {
  console.log(`[license-boundary] info: ${allowlisted.length} allowlisted value import(s) (boot/dispatch wiring).`);
}
if (violations.length > 0) {
  console.log(`[license-boundary] FAIL: ${violations.length} value import(s) of BSL paths outside the allowlist {boot.ts, dispatch.ts}:`);
  for (const f of violations) console.log(`  violation  ${f}`);
  process.exit(1);
}
console.log(
  `[license-boundary] OK: no value imports of BSL paths outside {boot.ts, dispatch.ts} ` +
  `(${warns.length} type-only warning(s), ${allowlisted.length} allowlisted).`,
);
