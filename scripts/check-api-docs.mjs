#!/usr/bin/env node
/**
 * check-api-docs.mjs — B1 spec gate.
 *
 * The HTTP API reference (`docs/API.md`) MUST list every route
 * registered in `crates/cinderpaw-core/src/api.rs::router()`. Drift between
 * the source (which is the source of truth) and the doc surfaces as
 * missing or extra routes — both are bugs.
 *
 * Strategy:
 *   1. Parse `api.rs`. Every route is registered as
 *      `.route("/path", get(handler))` / `post(...)` / `delete(...)`.
 *      We extract METHOD (from the verb token) and PATH (from the
 *      leading string literal). Axum's `merge` chains are resolved
 *      manually by walking forward.
 *   2. Parse `docs/API.md` and extract the canonical list from a
 *      fenced ```feral-api-routes ... ``` block near the bottom of the
 *      doc. Entries are `METHOD path`, one per line.
 *   3. Diff source-set vs doc-set. Report:
 *        MISSING (source has it, doc does not) — failure
 *        UNLISTED (doc has it, no source) — informational
 *
 * Usage:
 *   node scripts/check-api-docs.mjs            # exit 0 if clean
 *   node scripts/check-api-docs.mjs --strict   # exit 1 on MISSING
 *
 * Wired into the bun suite via CinderpawAgent/tests/api-docs.test.ts.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const API_RS = join(ROOT, "crates", "cinderpaw-core", "src", "api.rs");
const DOC = join(ROOT, "docs", "API.md");

function harvestRoutes() {
  if (!existsSync(API_RS)) {
    throw new Error(`api.rs not found at ${API_RS}`);
  }
  const text = readFileSync(API_RS, "utf8");
  // Match `.route("/path", get(handler))` (any verb). Multiline-safe;
  // captures: VERB and PATH.
  const re = /\.route\(\s*"([^"]+)"\s*,\s*(get|post|put|delete|patch)\s*\(/g;
  const out = new Map(); // path -> Set(method)
  for (const m of text.matchAll(re)) {
    const path = m[1];
    const method = m[2].toUpperCase();
    if (!out.has(path)) out.set(path, new Set());
    out.get(path).add(method);
  }
  // Flatten to one entry per (METHOD, path).
  const set = new Set();
  for (const [p, methods] of out) {
    for (const m of methods) set.add(`${m} ${p}`);
  }
  return set;
}

function documentedRoutes() {
  if (!existsSync(DOC)) {
    throw new Error(`docs/API.md not found at ${DOC}`);
  }
  const md = readFileSync(DOC, "utf8");
  const m = md.match(/```feral-api-routes\n([\s\S]*?)\n```/);
  if (!m) {
    throw new Error(
      "docs/API.md must contain a fenced block tagged ```feral-api-routes listing every route as METHOD path, one per line. See scripts/check-api-docs.mjs.",
    );
  }
  return new Set(
    m[1]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

function main() {
  const strict = process.argv.includes("--strict");
  const src = harvestRoutes();
  const doc = documentedRoutes();
  const missing = [...src].filter((r) => !doc.has(r)).sort();
  const unlisted = [...doc].filter((r) => !src.has(r)).sort();
  if (missing.length === 0 && unlisted.length === 0) {
    console.log(`[check-api-docs] OK — ${src.size} routes documented, none missing.`);
    return;
  }
  for (const r of missing) console.error(`MISSING (api.rs has it, doc does not): ${r}`);
  for (const r of unlisted) console.warn(`UNLISTED (doc has it, no source): ${r}`);
  if (strict && missing.length > 0) {
    process.exit(1);
  } else if (!strict) {
    console.log(
      `\n${missing.length} missing, ${unlisted.length} unlisted. Re-run with --strict to fail on missing.`,
    );
  }
}

main();
