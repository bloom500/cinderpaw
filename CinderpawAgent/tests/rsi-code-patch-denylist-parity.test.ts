/**
 * The two halves of the code-patch wall must agree.
 *
 * `DEFAULT_CODE_PATCH_POLICY.denylistBasenames` (TS) and `DENYLIST_BASENAMES`
 * (Rust, `crates/cinderpaw-core/src/rsi/code_patch.rs`) are the same list
 * written twice, and the comment above each has always said "kept in sync by
 * hand". Nothing checked it. A file protected on one side and not the other is
 * protected by whichever half happens to run first, which is not a trust
 * boundary — it is a coincidence.
 *
 * The list also grew on 2026-09-02 to cover the MEASUREMENT chain. It used to
 * protect only the files that DECIDE a verdict (contract, ratchet, confidence),
 * so a candidate could leave every one of them untouched and patch
 * `eval-spec.ts` instead: make `validateOutcome` return true and every task
 * passes, the score is perfect, and the ratchet advances on a suite that
 * measured nothing. These tests hold both properties.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DEFAULT_CODE_PATCH_POLICY } from "../src/rsi/l3-code/code-genome.ts";

const RUST_SOURCE = fileURLToPath(
  new URL("../../crates/cinderpaw-core/src/rsi/code_patch.rs", import.meta.url),
);

/** Pull `DENYLIST_BASENAMES` out of the Rust source, as strings. */
function rustDenylist(): string[] {
  const src = readFileSync(RUST_SOURCE, "utf8");
  const start = src.indexOf("const DENYLIST_BASENAMES");
  expect(start).toBeGreaterThanOrEqual(0);
  const open = src.indexOf("[", start);
  const close = src.indexOf("];", open);
  expect(close).toBeGreaterThan(open);
  const body = src.slice(open + 1, close);
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

describe("code-patch denylist — TS and Rust parity", () => {
  test("both halves protect exactly the same files", () => {
    const ts = [...DEFAULT_CODE_PATCH_POLICY.denylistBasenames].sort();
    const rust = [...rustDenylist()].sort();

    // Reported as a set difference in both directions: "which side is missing
    // what" is the only useful form of this failure.
    expect(rust.filter((f) => !ts.includes(f))).toEqual([]);
    expect(ts.filter((f) => !rust.includes(f))).toEqual([]);
    expect(ts).toEqual(rust);
  });

  test("the measurement chain is protected, not just the decision chain", () => {
    // Named individually rather than as a count: a count passes when someone
    // swaps one file for another, which is exactly the drift this guards.
    const measurement = [
      "eval-spec.ts", // validateOutcome — the per-task verdict
      "run-eval.ts", // builds the EvalOutcome[] the scorer reads
      "eval-worker.ts", // emits the score
      "get-specs.ts", // assembles the suite
      "default-tier-specs.ts", // the Tier 1/2 tasks
      "invoke-agent.ts", // produces the answers being graded
      "fitness.ts",
      "personal-fitness.ts",
      "budget.ts",
      "journal.ts",
      "hash-chain.ts",
      "event-bus.ts",
      "provenance.ts",
    ];
    for (const file of measurement) {
      expect(DEFAULT_CODE_PATCH_POLICY.denylistBasenames).toContain(file);
    }
  });

  test("the wall still protects the decision chain it started with", () => {
    for (const file of [
      "code-genome.ts",
      "code-sandbox.ts",
      "contract-runner.ts",
      "contract-leaves.ts",
      "ratchet-handler.ts",
      "confidence.ts",
      "pending-patches.ts",
    ]) {
      expect(DEFAULT_CODE_PATCH_POLICY.denylistBasenames).toContain(file);
    }
  });
});
