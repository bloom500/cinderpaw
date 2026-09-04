#!/usr/bin/env bun
/**
 * check-invariant-coverage.ts — Linter for INVARIANTS.md four-pillar discipline.
 *
 * Each invariant in `docs/invariants.md` has four pillars (per §2):
 *   1. Documentation — in INVARIANTS.md (always present by construction)
 *   2. Test          — a test file references the invariant by ID
 *   3. Runtime Assert — source code enforces the invariant (or the
 *                       enforcement mechanism names the invariant)
 *   4. Audit         — the invariant's checks land in the audit chain
 *                       (or the audit mechanism names the invariant)
 *
 * Without `--strict`: report-only. Exit 0.
 * With    `--strict`: exit 1 if any HARD invariant is missing any pillar.
 * With    `--json`:   machine-readable output.
 *
 * The script encourages the discipline of explicit invariant IDs in
 * test / runtime / audit code. As Opus wires the Contract FSM, each
 * new gate should add `// INVARIANT I[N]: ...` markers; this linter
 * picks them up.
 *
 * Usage:
 *   bun run scripts/check-invariant-coverage.ts
 *   bun run scripts/check-invariant-coverage.ts --strict
 *   bun run scripts/check-invariant-coverage.ts --json
 *
 * Exit codes:
 *   0 - all HARD invariants have all 4 pillars (or report-only mode)
 *   1 - one or more HARD invariants missing a pillar (strict mode)
 *   2 - script error (file not found, parse error)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const INVARIANTS_MD = "docs/invariants.md";
/**
 * `crates/` was missing, and seven of the fifteen HARD invariants name a Rust
 * file as their owner (I1, I2, I7, I8, I9, I12, I13 → repo.rs, scorer.rs,
 * tier0.rs, sandbox_bounds.rs, paths.rs). I9 is implemented in 422 lines of
 * sandbox_bounds.rs, loaded at boot and behind a Tauri command, with inline
 * tests — and this linter reported it as missing Test, Runtime AND Audit,
 * because it never opened the file. A coverage report that cannot see half the
 * enforcement teaches people to ignore it, which costs more than having no
 * report at all.
 */
const SRC_DIRS = [
  "CinderpawAgent/src",
  "CinderpawAgent/tests",
  "src-tauri/src",
  "crates",
];
/** Rust puts tests inline (`mod tests`) or under `<crate>/tests/`, neither of
 *  which ends in `.test.ts`; without this every Rust test counted as runtime. */
const TEST_PATTERN = /\.test\.ts$|(^|\/)tests\/[^/]+\.rs$/;
const SOURCE_PATTERN = /\.(ts|rs)$/;

interface PillarStatus {
  documentation: boolean;
  test: boolean;
  runtime: boolean;
  audit: boolean;
  testRef?: string;
  runtimeRef?: string;
  auditRef?: string;
}

interface Invariant {
  id: string;
  name: string;
  klass: "HARD" | "SOFT";
  status: string;
  pillars: PillarStatus;
}

interface CoverageReport {
  totalHard: number;
  hardWithAllPillars: number;
  hardMissingPillars: number;
  totalSoft: number;
  softWithAllPillars: number;
  softMissingPillars: number;
  invariants: Invariant[];
}

/* ------------------------------------------------------------------ *
 * Parse INVARIANTS.md
 * ------------------------------------------------------------------ */

function parseInvariants(): Invariant[] {
  const path = join(ROOT, INVARIANTS_MD);
  let md: string;
  try {
    md = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read ${INVARIANTS_MD} from ${ROOT}`);
  }

  const invariants: Invariant[] = [];
  const lines = md.split("\n");
  let currentClass: "HARD" | "SOFT" = "HARD";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Track section (Hard vs Soft Invariants)
    if (line.match(/^## \d+\. Hard Invariants/)) {
      currentClass = "HARD";
      continue;
    }
    if (line.match(/^## \d+\. Soft Invariants/)) {
      currentClass = "SOFT";
      continue;
    }

    // Match `### Invariant I[N] — [Name]` or `### Invariant S[N] — [Name]`
    const m = line.match(/^### Invariant (I\d+|S\d+) — (.+)$/);
    if (!m) continue;

    const id = m[1]!;
    const name = m[2]!.trim();

    // Find Status in next ~40 lines
    let status = "UNKNOWN";
    for (let j = i + 1; j < Math.min(i + 40, lines.length); j++) {
      const sLine = lines[j]!;
      const sMatch = sLine.match(/^\*\*Status:\*\* (.+)$/);
      if (sMatch) {
        status = sMatch[1]!.trim();
        break;
      }
    }

    invariants.push({
      id,
      name,
      klass: currentClass,
      status,
      pillars: {
        documentation: true,
        test: false,
        runtime: false,
        audit: false,
      },
    });
  }

  return invariants;
}

/* ------------------------------------------------------------------ *
 * Scan source tree for invariant references
 * ------------------------------------------------------------------ */

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (SOURCE_PATTERN.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

interface IdReferences {
  test?: string;
  runtime?: string;
  audit?: string;
}

/** Find which files reference the invariant ID. Categorises:
 *  - test files (TEST_PATTERN) → test pillar
 *  - audit files (path includes 'audit') → audit pillar
 *  - everything else → runtime pillar
 *
 *  Multiple references are tracked but only the first is reported
 *  per category for brevity. */
function scanForId(id: string): IdReferences {
  const result: IdReferences = {};
  const re = new RegExp(`\\b${id}\\b`);

  for (const dir of SRC_DIRS) {
    const absDir = join(ROOT, dir);
    for (const file of walkFiles(absDir)) {
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!re.test(content)) continue;

      const rel = relative(ROOT, file).split(sep).join("/");
      if (TEST_PATTERN.test(file)) {
        if (result.test === undefined) result.test = rel;
      } else if (rel.includes("audit")) {
        if (result.audit === undefined) result.audit = rel;
      } else {
        if (result.runtime === undefined) result.runtime = rel;
      }
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

function buildReport(invariants: Invariant[]): CoverageReport {
  const hard = invariants.filter((i) => i.klass === "HARD");
  const soft = invariants.filter((i) => i.klass === "SOFT");
  const hardComplete = hard.filter((i) =>
    i.pillars.documentation &&
    i.pillars.test &&
    i.pillars.runtime &&
    i.pillars.audit,
  );
  const softComplete = soft.filter((i) =>
    i.pillars.documentation &&
    i.pillars.test &&
    i.pillars.runtime &&
    i.pillars.audit,
  );
  return {
    totalHard: hard.length,
    hardWithAllPillars: hardComplete.length,
    hardMissingPillars: hard.length - hardComplete.length,
    totalSoft: soft.length,
    softWithAllPillars: softComplete.length,
    softMissingPillars: soft.length - softComplete.length,
    invariants,
  };
}

function pct(n: number, d: number): string {
  if (d === 0) return "n/a";
  return `${Math.round((n / d) * 100)}%`;
}

function printHumanReport(report: CoverageReport, mode: "report" | "strict"): void {
  const { invariants } = report;
  console.log("");
  console.log("=== INVARIANT COVERAGE REPORT ===");
  console.log(`(${INVARIANTS_MD} → four-pillar check)`);
  console.log("");

  for (const inv of invariants) {
    const cls = inv.klass === "HARD" ? "[HARD]" : "[SOFT]";
    const status = inv.status.length > 14 ? inv.status.slice(0, 13) + "…" : inv.status;
    console.log(`${inv.id.padEnd(4)} ${cls} ${status.padEnd(15)} — ${inv.name}`);
    const checks = [
      ["Doc", inv.pillars.documentation],
      ["Test", inv.pillars.test],
      ["Runtime", inv.pillars.runtime],
      ["Audit", inv.pillars.audit],
    ] as const;
    const symbols = checks
      .map(([name, ok]) => `${ok ? "✓" : "✗"} ${name}`)
      .join("  ");
    console.log(`      ${symbols}`);
    if (inv.pillars.testRef) {
      console.log(`      test:     ${inv.pillars.testRef}`);
    }
    if (inv.pillars.runtimeRef) {
      console.log(`      runtime:  ${inv.pillars.runtimeRef}`);
    }
    if (inv.pillars.auditRef) {
      console.log(`      audit:    ${inv.pillars.auditRef}`);
    }
    console.log("");
  }

  console.log("--- Summary ---");
  console.log(
    `HARD: ${report.hardWithAllPillars}/${report.totalHard} complete (${pct(report.hardWithAllPillars, report.totalHard)})`,
  );
  console.log(
    `SOFT: ${report.softWithAllPillars}/${report.totalSoft} complete (${pct(report.softWithAllPillars, report.totalSoft)})`,
  );
  console.log(
    `HARD missing pillars: ${report.hardMissingPillars}; SOFT missing: ${report.softMissingPillars}`,
  );
  console.log("");
  console.log(`Mode: ${mode}`);
  if (report.hardMissingPillars === 0) {
    console.log("✅ All HARD invariants have all 4 pillars.");
  } else if (mode === "strict") {
    console.log(
      `❌ ${report.hardMissingPillars} HARD invariant(s) missing pillar(s). Add explicit // INVARIANT I[N] markers in tests / runtime / audit code.`,
    );
  } else {
    console.log(
      `⚠️  ${report.hardMissingPillars} HARD invariant(s) missing pillar(s). Re-run with --strict to fail.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function main(): void {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const json = args.includes("--json");
  const mode = strict ? "strict" : "report";

  const invariants = parseInvariants();
  if (invariants.length === 0) {
    console.error(`No invariants parsed from ${INVARIANTS_MD}. Check the file format.`);
    process.exit(2);
  }

  for (const inv of invariants) {
    const refs = scanForId(inv.id);
    inv.pillars.test = refs.test !== undefined;
    inv.pillars.runtime = refs.runtime !== undefined;
    inv.pillars.audit = refs.audit !== undefined;
    inv.pillars.testRef = refs.test;
    inv.pillars.runtimeRef = refs.runtime;
    inv.pillars.auditRef = refs.audit;
  }

  const report = buildReport(invariants);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report, mode);
  }

  if (strict && report.hardMissingPillars > 0) {
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error(`check-invariant-coverage: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}