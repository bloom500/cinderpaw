#!/usr/bin/env node
/**
 * check-env-docs.mjs — B2 spec gate, extended by R3.
 *
 * The configuration doc (`docs/CONFIGURATION.md`) MUST list every
 * `CINDERPAW_*` env var that appears in source. The spec calls for a
 * machine-checkable drift detector so the doc cannot silently rot
 * when someone adds a new env var.
 *
 * Strategy (unchanged from B2):
 *   1. Grep CinderpawAgent/src, src-tauri/src, crates/ for `CINDERPAW_[A-Z_]+`
 *      (rg --no-filename; fall back to a node walker if rg is missing).
 *   2. Parse `docs/CONFIGURATION.md` and extract the canonical list
 *      from a fenced ```cinderpaw-env-vars ... ``` block near the top of the
 *      doc. Anything in that block is "documented"; anything outside it
 *      is ignored (so we don't false-positive on prose mentions).
 *   3. Diff source-set vs doc-set. Report:
 *        MISSING (in source, not in doc) — failure
 *        UNLISTED (in doc, not in source) — informational
 *      Test sentinels (`CINDERPAW_DOES_NOT_EXIST_XYZ`, `CINDERPAW_TEST_*`) are
 *      hard-coded excludes; add to this list only with consensus.
 *
 * R3 additions — the TS side now has a single source of truth,
 * `CinderpawAgent/src/config.ts`'s `CONFIG_SCHEMA`. Two new checks:
 *   4. Every `CONFIG_SCHEMA` entry name must appear in the doc's
 *      `cinderpaw-env-vars` fence (schema-missing — always fails).
 *   5. The doc's generated `<!-- TS-SCHEMA-TABLE -->` section must equal
 *      what `scripts/gen-config-docs.mjs` would produce right now
 *      (doc-stale — always fails). This is the literal "is the committed
 *      doc stale vs a fresh generator run" check.
 * Neither of these widens what the original MISSING/UNLISTED check
 * tolerates — they are strictly additional, always-on gates layered on
 * top of the unchanged B2 logic.
 *
 * Usage:
 *   node scripts/check-env-docs.mjs            # exit 0 if clean
 *   node scripts/check-env-docs.mjs --strict   # exit 1 on MISSING
 *
 * Wired into the bun suite via CinderpawAgent/tests/env-docs.test.ts.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfigSchema, renderTable } from "./gen-config-docs.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DOC = join(ROOT, "docs", "CONFIGURATION.md");
const CONFIG_TS = join(ROOT, "CinderpawAgent", "src", "config.ts");

const SOURCE_ROOTS = [
  join("CinderpawAgent", "src"),
  join("src-tauri", "src"),
  "crates",
];
const TEST_SENTINELS = new Set([
  "CINDERPAW_DOES_NOT_EXIST_XYZ",
  "CINDERPAW_TEST_BAD__",
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
  const re = /CINDERPAW_[A-Z][A-Z0-9_]+/g;
  const found = new Set();
  const filterBarePrefix = (name) => {
    if (name === "CINDERPAW_RSI_") return false;
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
        "CINDERPAW_[A-Z][A-Z0-9_]+",
        "CinderpawAgent/src",
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
  // Normalise line endings before matching. `core.autocrlf=true` is git's
  // default on Windows, so a fresh clone there checks this file out with
  // CRLF and the fence never matched — the check failed with "must contain
  // a fenced code block" while pointing at a file that plainly contains one.
  // The convention of the checkout is not the thing being checked.
  const md = readFileSync(DOC, "utf8").replace(/\r\n?/g, "\n");
  const m = md.match(/```cinderpaw-env-vars\n([\s\S]*?)\n```/);
  if (!m) {
    throw new Error(
      "docs/CONFIGURATION.md must contain a fenced code block tagged ```cinderpaw-env-vars listing every var name, one per line. See scripts/check-env-docs.mjs.",
    );
  }
  return new Set(
    m[1]
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

/**
 * R3 check 4: every CONFIG_SCHEMA entry name must be in the doc's
 * cinderpaw-env-vars fence. Always fails (not gated by --strict) — the
 * schema is the TS source of truth now, so drift here is a hard bug.
 */
function checkSchemaNamesDocumented(doc) {
  const configSrc = readFileSync(CONFIG_TS, "utf8");
  const schema = parseConfigSchema(configSrc);
  const missing = schema.map((e) => e.name).filter((n) => !doc.has(n)).sort();
  return { schema, missing };
}

/**
 * R3 check 5: the doc's <!-- TS-SCHEMA-TABLE --> section must equal what
 * gen-config-docs.mjs would produce right now. Always fails — a stale
 * generated section defeats the point of generating it.
 */
function checkGeneratedTableFresh(configSrc) {
  const md = readFileSync(DOC, "utf8");
  const marker = "<!-- TS-SCHEMA-TABLE -->";
  const endMarker = "<!-- /TS-SCHEMA-TABLE -->";
  const start = md.indexOf(marker);
  const end = md.indexOf(endMarker);
  if (start === -1 || end === -1) {
    return { stale: true, reason: `docs/CONFIGURATION.md is missing ${marker}/${endMarker}` };
  }
  const committed = md.slice(start + marker.length, end).trim();
  const fresh = renderTable(parseConfigSchema(configSrc)).trim();
  if (committed !== fresh) {
    return {
      stale: true,
      reason: "docs/CONFIGURATION.md's TS-SCHEMA-TABLE is stale vs CinderpawAgent/src/config.ts. Run `node scripts/gen-config-docs.mjs` and commit the result.",
    };
  }
  return { stale: false };
}

function main() {
  const strict = process.argv.includes("--strict");
  const src = harvestVars();
  const doc = documentedVars();
  const missing = [...src].filter((v) => !doc.has(v)).sort();
  const unlisted = [...doc].filter((v) => !src.has(v)).sort();

  const configSrc = readFileSync(CONFIG_TS, "utf8");
  const { schema, missing: schemaMissing } = checkSchemaNamesDocumented(doc);
  const { stale, reason: staleReason } = checkGeneratedTableFresh(configSrc);

  let hardFail = false;
  if (schemaMissing.length > 0) {
    hardFail = true;
    for (const v of schemaMissing) {
      console.error(`SCHEMA-MISSING (config.ts CONFIG_SCHEMA has it, docs/CONFIGURATION.md fence does not): ${v}`);
    }
  }
  if (stale) {
    hardFail = true;
    console.error(staleReason);
  }

  if (missing.length === 0 && unlisted.length === 0 && !hardFail) {
    console.log(
      `[check-env-docs] OK — ${src.size} env vars documented, none missing. ` +
        `${schema.length} config.ts schema rows verified fresh.`,
    );
    return;
  }
  for (const v of missing) console.error(`MISSING (source has it, doc does not): ${v}`);
  for (const v of unlisted) console.warn(`UNLISTED (doc has it, no source reference): ${v}`);
  if (hardFail || (strict && missing.length > 0)) {
    process.exit(1);
  } else if (!strict) {
    console.log(
      `\n${missing.length} missing, ${unlisted.length} unlisted. Re-run with --strict to fail on missing.`,
    );
  }
}

main();
