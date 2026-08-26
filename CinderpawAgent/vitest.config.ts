/**
 * vitest.config.ts — second test gate for the sidecar.
 *
 * The OFFICIAL gate is `bun test` (AGENTS.md) and runs the whole 279-file
 * suite on the Bun runtime. This gate runs the RUNNER-AGNOSTIC suites
 * (the ARC modules) under Vitest, per Darius' explicit requirement.
 *
 * Deliberately scoped: the remaining 276 legacy files are Bun-coupled
 * beyond their bun:test imports — src/db.ts imports `bun:sqlite` (52
 * files fail on it alone), several use Bun-only matchers and dynamic
 * executable imports. Making those Vitest-green is documented follow-up
 * work in OPUS_RECEIPT_20260825_MCTS.md, NOT silently skipped here.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const runnerVitest = fileURLToPath(new URL("./tests/_runner-vitest.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "bun:test": runnerVitest,
    },
  },
  test: {
    include: [
      "tests/mcts-verifier.test.ts",
      "tests/causal-explorer.test.ts",
      "tests/maze-selftest-runner.test.ts",
      "tests/test-time-adaptation.test.ts",
      "tests/goal-backward-planner.test.ts",
      "tests/metacognitive-auditor.test.ts",
      "tests/skill-induction.test.ts",
      "tests/run-manifest.test.ts",
    ],
  },
});
