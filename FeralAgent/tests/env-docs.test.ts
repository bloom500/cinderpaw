/**
 * env-docs.test.ts — B2 spec gate.
 *
 * Every `FERAL_*` env var referenced in source MUST be listed in the
 * canonical fence inside `docs/CONFIGURATION.md`. Otherwise the doc
 * silently rots when someone adds a new var.
 *
 * Drift is enforced via `scripts/check-env-docs.mjs`. This test is the
 * `bun test` mirror: any CI runner that only runs `bun test` (and
 * doesn't run the standalone script) still gets the same coverage.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from this test file until we find the directory that
 * contains `scripts/check-env-docs.mjs`. Tests can run from any cwd
 * (`bun test` invoked from repo root OR from FeralAgent/), so we can't
 * rely on `process.cwd()` or `import.meta.url` alone.
 */
function findRepoRoot() {
  let cur = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, "scripts", "check-env-docs.mjs"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error(
    "could not locate the repo root (no scripts/check-env-docs.mjs found above this test file)",
  );
}

const REPO_ROOT = findRepoRoot();

describe("docs/CONFIGURATION.md env-var coverage", () => {
  test("no FERAL_* env var in source is missing from the doc", () => {
    const script = join(REPO_ROOT, "scripts", "check-env-docs.mjs");
    const out = spawnSync("node", [script, "--strict"], {
      encoding: "utf8",
    });

    if (out.status !== 0) {
      const stdout = out.stdout ?? "";
      const stderr = out.stderr ?? "";
      throw new Error(
        `env-docs drift detected. Re-run \`node scripts/check-env-docs.mjs\` and add the missing var(s) to docs/CONFIGURATION.md.\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    // Sanity-check that the script reported a non-trivial count.
    expect(out.stdout ?? "").toContain("env vars documented");
  }, 30_000);
});
