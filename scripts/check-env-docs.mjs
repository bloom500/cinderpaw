#!/usr/bin/env node
/**
 * check-env-docs.mjs — B2 spec gate.
 *
 * The configuration doc (`docs/CONFIGURATION.md`) MUST list every
 * `FERAL_*` env var that appears in source. The spec calls for a
 * machine-checkable drift detector so the doc cannot silently rot
 * when someone adds a new env var.
 *
 * Strategy:
 *   1. Grep FeralAgent/src, src-tauri/src, crates/ for `FERAL_[A-Z_]+`
 *      (rg --no-filename; fall back to a node walker if rg is missing).
 *   2. Parse `docs/CONFIGURATION.md` and extract the canonical list
 *      from a fenced ```feral-env-vars ... ``` block near the top of the
 *      doc. Anything in that block is "documented"; anything outside it
 *      is ignored (so we don't false-positive on prose mentions).
 *   3. Diff source-set vs doc-set. Report:
 *        MISSING (in source, not in doc) — failure
 *        UNLISTED (in doc, not in source) — informational
 *      Test sentinels (`FERAL_DOES_NOT_EXIST_XYZ`, `FERAL_TEST_*`) are
 *      hard-coded excludes; add to this list only with consensus.
 *
 * Usage:
 *   node scripts/check-env-docs.mjs            # exit 0 if clean
 *   node scripts/check-env-docs.mjs --strict   # exit 1 on MISSING
 *
 * Wired into the bun suite via FeralAgent/tests/env-docs.test.ts.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DOC = join(ROOT, "docs", "CONFIGURATION.md");

const SOURCE_ROOTS = [
  join("FeralAgent", "src"),
  join("src-tauri", "src"),
  "crates",
];
const TEST_SENTINELS = new Set([
  "FERAL_DOES_NOT_EXIST_XYZ",
  "FERAL_TEST_BAD__",
]);

function rgAvailable() {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function harvestVars() {
  const re = /FERAL_[A-Z][A-Z0-9_]+/g;
  const found = new Set();
  const filterBarePrefix = (name) => {
    if (name === "FERAL_RSI_") return false;
    if (/_$/.test(name)) return false;
    return true;
  };
  if (rgAvailable()) {
    const out = execFileSync(
      "rg",
      [
        "--no-filename",
        "--type-add",
        "ts:*.ts",
        "--type-add",
        "rs:*.rs",
        "-o",
        "-t",
        "ts",
        "-t",
        "rs",
        "FERAL_[A-Z][A-Z0-9_]+",
        "FeralAgent/src",
        "src-tauri/src",
        "crates",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    for (const m of out.matchAll(re)) {
      if (filterBarePrefix(m[0])) found.add(m[0]);
    }
  } else {
    function walk(p) {
      let entries;
      try {
        entries = readdirSync(p, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const fp = join(p, e.name);
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === "target")
            continue;
          walk(fp);
        } else if (e.isFile() && /\.(ts|rs)$/.test(e.name)) {
          const txt = readFileSync(fp, "utf8");
          for (const m of txt.matchAll(re)) {
            if (filterBarePrefix(m[0])) found.add(m[0]);
          }
        }
      }
    }
    for (const root of SOURCE_ROOTS) walk(join(ROOT, root));
  }
  for (const t of TEST_SENTINELS) found.delete(t);
  return new Set([...found].sort());
}

function documentedVars() {
  if (!existsSync(DOC)) {
    throw new Error(`docs/CONFIGURATION.md not found at ${DOC}`);
  }
  const md = readFileSync(DOC, "utf8");
  const m = md.match(/```feral-env-vars\n([\s\S]*?)\n```/);
  if (!m) {
    throw new Error(
      "docs/CONFIGURATION.md must contain a fenced code block tagged ```feral-env-vars listing every var name, one per line. See scripts/check-env-docs.mjs.",
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
  const src = harvestVars();
  const doc = documentedVars();
  const missing = [...src].filter((v) => !doc.has(v)).sort();
  const unlisted = [...doc].filter((v) => !src.has(v)).sort();
  if (missing.length === 0 && unlisted.length === 0) {
    console.log(`[check-env-docs] OK — ${src.size} env vars documented, none missing.`);
    return;
  }
  for (const v of missing) console.error(`MISSING (source has it, doc does not): ${v}`);
  for (const v of unlisted) console.warn(`UNLISTED (doc has it, no source reference): ${v}`);
  if (strict && missing.length > 0) {
    process.exit(1);
  } else if (!strict) {
    console.log(
      `\n${missing.length} missing, ${unlisted.length} unlisted. Re-run with --strict to fail on missing.`,
    );
  }
}

main();
