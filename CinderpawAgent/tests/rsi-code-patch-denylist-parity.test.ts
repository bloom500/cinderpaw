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

import { proposableFiles } from "../src/rsi/l3-code/code-proposer.ts";
import {
  DEFAULT_CODE_PATCH_POLICY,
  isDiffParseError,
  parseUnifiedDiff,
  validateCodePatch,
} from "../src/rsi/l3-code/code-genome.ts";

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

  test("the files that feed the scorer and hold the gate's baseline are protected", () => {
    // Left out when the measurement chain was listed: `adapters.ts` maps the
    // EvalOutcome[] onto the Rust scorer's input (drop the failed ones and the
    // score is perfect), `sidecar.ts` composes the confidence-gate thresholds,
    // and `champion.ts` persists the per-task baseline the gate pairs against.
    for (const file of ["adapters.ts", "sidecar.ts", "champion.ts"]) {
      expect(DEFAULT_CODE_PATCH_POLICY.denylistBasenames).toContain(file);
      expect(rustDenylist()).toContain(file);
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

  test("L3 cannot patch the layers that govern it, nor its own search", () => {
    // Astra, 12 Sep 2026: governance.ts, governance-lifecycle.ts and
    // meta-evolution.ts were legal targets. The proposer and selector are the
    // recursion hook, closed until S5 of the recursive-learning spec.
    for (const file of [
      "governance.ts",
      "governance-lifecycle.ts",
      "governance-audit.ts",
      "meta-evolution.ts",
      "module-wall.ts",
      "code-proposer.ts",
      "experiment-selector.ts",
      "self-model.ts",
    ]) {
      expect(DEFAULT_CODE_PATCH_POLICY.denylistBasenames).toContain(file);
      expect(
        proposableFiles([`l5-gov/${file}`, "l1-config/mutation.ts"]),
        `${file} must not be offered to the proposer`,
      ).toEqual(["l1-config/mutation.ts"]);
    }
  });

  test("the walls, gates and wires of L2, L3 and L4 are protected, not only L1's", () => {
    // 26 Sep: validateCodePatch accepted every one of these. `isolation.ts`
    // even said in its header that it was on this list; it was not. A human
    // still approves each applied patch, and this list is so that click is
    // not the only wall. Paths are real, so the patch goes through the same
    // parser and wall a proposal does.
    const walls = [
      "l3-code/isolation.ts", // the Docker cell a code candidate runs in
      "l4-modules/module-host-client.ts", // spawns a module, runs its wall, scrubs the env
      "l4-modules/module-host.ts", // the child process a module executes in
      "l4-modules/module-eval.ts", // the L4 paired gate
      "l4-modules/module-lifecycle.ts", // freeze, approval and promotion of a module
      "l4-modules/module-registry.ts", // which implementation serves a seam
      "l4-modules/seam-adapter.ts", // the watchdog that quarantines a failing module
      "l4-modules/module-proposer.ts", // runs the lexical wall before a module reaches disk
      "l2-adapt/lora-eval-gate.ts", // the L2 verdict
      "l2-adapt/lora-eval-runner.ts", // the paired A/B that feeds it
      "l2-adapt/lora-registry.ts", // the champion adapter and its rollback
      "l2-adapt/lora-pipeline.ts", // approve only on a recommend_promote verdict
      "infra/bridge.ts", // the wire to the Rust scorer and ratchet
      "infra/tier-loader.ts", // loads the Tier 1/2 suite, refuses a partial one
      "infra/fixtures.ts", // the campaign's held-out promotion partitions
      "infra/instance-paths.ts", // where the governance, journal and champion files live
    ];
    for (const rel of walls) {
      const path = `src/rsi/${rel}`;
      const parsed = parseUnifiedDiff(
        `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-a
+b
`,
      );
      if (isDiffParseError(parsed)) throw new Error(`fixture did not parse for ${path}`);
      const v = validateCodePatch(parsed);
      expect(v.ok, `${path} must be refused`).toBe(false);
      const base = rel.split("/").pop()!;
      expect(rustDenylist(), `${base} missing on the Rust side`).toContain(base);
    }
  });
});
