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
 *      `.route("/path", get(handler).post(other_handler))`, with a literal
 *      path and simple handler names. Whitespace and trailing commas are
 *      supported. Every explicitly registered chained verb is extracted.
 *      Other route shapes and router merge/nest composition fail clearly;
 *      this is a bounded source check, not a general Rust/Axum parser.
 *   2. Parse `docs/API.md` and extract the canonical list from a
 *      fenced ```cinderpaw-api-routes ... ``` block near the bottom of the
 *      doc. Entries are `METHOD path`, one per line.
 *   3. Diff source-set vs doc-set. Report:
 *        MISSING (source has it, doc does not) — failure with --strict
 *        UNLISTED (doc has it, no source) — informational
 *
 * Usage:
 *   node scripts/check-api-docs.mjs            # report drift; missing/unlisted do not fail
 *   node scripts/check-api-docs.mjs --strict   # exit 1 on MISSING
 *
 * Wired into the bun suite via CinderpawAgent/tests/api-docs.test.ts.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const API_RS = join(ROOT, "crates", "cinderpaw-core", "src", "api.rs");
const DOC = join(ROOT, "docs", "API.md");

export function harvestRoutes(source) {
  // Ignore full-line comments, including commented-out registrations.
  const text = source.replace(/^\s*\/\/[^\r\n]*/gm, "");
  if (/\.(?:merge|nest|nest_service|route_service)\s*\(/.test(text)) {
    throw new Error("Unsupported API router composition; extend check-api-docs before using merge/nest/service routes.");
  }
  const verb = "(?:get|post|put|delete|patch|head|options|trace|connect)";
  const call = `${verb}\\s*\\(\\s*[A-Za-z_][A-Za-z0-9_:]*\\s*\\)`;
  // Sticky matching requires the complete route shape at each registration;
  // unfamiliar shapes must not silently disappear from the inventory.
  const route = new RegExp(`\\.route\\s*\\(\\s*"(/[^"\\\\]*)"\\s*,\\s*(${call}(?:\\s*\\.\\s*${call})*)\\s*,?\\s*\\)`, "y");
  const set = new Set();
  for (const start of text.matchAll(/\.route\s*\(/g)) {
    route.lastIndex = start.index;
    const matched = route.exec(text);
    if (!matched) {
      throw new Error(`Unsupported API route registration: ${text.slice(start.index, start.index + 140).trim()}`);
    }
    for (const method of matched[2].matchAll(new RegExp(`(${verb})\\s*\\(`, "g"))) {
      set.add(`${method[1].toUpperCase()} ${matched[1]}`);
    }
  }
  return set;
}

function documentedRoutes() {
  if (!existsSync(DOC)) {
    throw new Error(`docs/API.md not found at ${DOC}`);
  }
  const md = readFileSync(DOC, "utf8");
  const m = md.match(/```cinderpaw-api-routes\n([\s\S]*?)\n```/);
  if (!m) {
    throw new Error(
      "docs/API.md must contain a fenced block tagged ```cinderpaw-api-routes listing every route as METHOD path, one per line. See scripts/check-api-docs.mjs.",
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
  const src = harvestRoutes(readFileSync(API_RS, "utf8"));
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
