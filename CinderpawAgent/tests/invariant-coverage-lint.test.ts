/**
 * The coverage linter is the instrument the invariant work is measured with,
 * and it has already lied twice: it reported the Rust-side invariants as
 * unenforced because it could not see `crates/`, and it credited the Audit
 * pillar to any id merely mentioned under a path containing "audit". Both made
 * the report unimprovable by correct work, which teaches people to ignore it.
 *
 * These tests hold the two rules that replaced the guesswork: a pillar is
 * claimed by an explicit marker at the code that satisfies it, and an invariant
 * whose doc says an audit row is not applicable is not counted as missing one.
 *
 * Ids are built at runtime, never written literally: the linter greps the whole
 * source tree for `\bI<n>\b`, so a literal id in this file would make this file
 * the "test pillar" for an invariant it does not test.
 */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const id = (n: number) => `I${n}`;

interface Pillars {
  documentation: boolean;
  test: boolean;
  runtime: boolean;
  audit: boolean;
  auditNotApplicable: boolean;
  testRef?: string;
  runtimeRef?: string;
  auditRef?: string;
}
interface Report {
  invariants: { id: string; klass: string; pillars: Pillars }[];
}

const report: Report = JSON.parse(
  execFileSync(
    process.execPath,
    ["run", join(REPO_ROOT, "scripts", "check-invariant-coverage.ts"), "--json"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  ),
);
const byId = new Map(report.invariants.map((i) => [i.id, i]));

describe("invariant coverage linter", () => {
  it("parses every hard invariant in the doc", () => {
    expect(byId.has(id(1))).toBe(true);
    expect(byId.has(id(15))).toBe(true);
  });

  it("credits the audit pillar only where the marker actually is", () => {
    for (const inv of report.invariants) {
      if (!inv.pillars.audit) continue;
      const file = readFileSync(join(REPO_ROOT, inv.pillars.auditRef!), "utf8");
      expect(file).toContain(`INVARIANT ${inv.id} AUDIT`);
    }
  });

  it("does not count an audit row the doc calls not applicable as missing", () => {
    // The bounded pure-function invariant: no side effect, so no row to write.
    const pure = byId.get(id(10))!;
    expect(pure.pillars.auditNotApplicable).toBe(true);
    expect(pure.pillars.audit).toBe(false);
  });

  it("reads a Rust file for both the runtime and the test pillar", () => {
    // The old one-bucket-per-file rule made an inline `mod tests` invisible.
    const sandbox = byId.get(id(9))!;
    expect(sandbox.pillars.runtimeRef).toContain("crates/");
    expect(sandbox.pillars.testRef).toContain(".rs");
  });
});
