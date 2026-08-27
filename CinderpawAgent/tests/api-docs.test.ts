/**
 * api-docs.test.ts — B1 spec gate.
 *
 * Every route in `crates/cinderpaw-core/src/api.rs::router()` MUST be listed
 * in `docs/API.md`. Otherwise the API reference silently rots.
 *
 * Drift is enforced via `scripts/check-api-docs.mjs`. This test is the
 * `bun test` mirror.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot() {
  let cur = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(cur, "scripts", "check-api-docs.mjs"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  throw new Error(
    "could not locate the repo root (no scripts/check-api-docs.mjs found above this test file)",
  );
}

const REPO_ROOT = findRepoRoot();

describe("docs/API.md route coverage", () => {
  test("no route in api.rs::router() is missing from the doc", () => {
    const script = join(REPO_ROOT, "scripts", "check-api-docs.mjs");
    const out = spawnSync("node", [script, "--strict"], { encoding: "utf8" });

    if (out.status !== 0) {
      const stdout = out.stdout ?? "";
      const stderr = out.stderr ?? "";
      throw new Error(
        `api-docs drift detected. Re-run \`node scripts/check-api-docs.mjs\` and add the missing route(s) to docs/API.md.\n` +
          `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }

    expect(out.stdout ?? "").toContain("routes documented");
  }, 30_000);
});
