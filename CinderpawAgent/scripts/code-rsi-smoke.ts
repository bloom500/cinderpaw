/**
 * Code-RSI live smoke probe — the TS half of the pipeline against the REAL
 * repo: handcrafted trivial patch → TS wall → disposable worktree (bun
 * install + FULL suite + tsc + build at HEAD) → raw measurements.
 *
 * The Rust half (wall re-assert, score, commit, ratchet) needs the running
 * host; this probe prints the score the locked Rust formula WOULD produce,
 * clearly labelled as a local reconstruction for display.
 *
 * Run: bun scripts/code-rsi-smoke.ts   (from CinderpawAgent/; ~2-5 min)
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDiffParseError, parseUnifiedDiff, validateCodePatch } from "../src/rsi/code-genome.ts";
import { evaluateCodePatch, bunExec } from "../src/rsi/code-sandbox.ts";

const repoRoot = resolve(import.meta.dir, "..", "..");
const target = "strategy-seeds.ts"; // real rsi/ file, not denylisted

// Build a trivial real patch: append one comment line at the end.
const source = readFileSync(join(repoRoot, "CinderpawAgent", "src", "rsi", target), "utf8");
const lines = source.split("\n");
// Trailing newline → last element is ""; the real last line sits above it.
const lastIdx = lines[lines.length - 1] === "" ? lines.length - 2 : lines.length - 1;
const lastLine = lines[lastIdx]!;
const lineNo = lastIdx + 1;
const patch = [
  `--- a/src/rsi/${target}`,
  `+++ b/src/rsi/${target}`,
  `@@ -${lineNo},1 +${lineNo},2 @@`,
  ` ${lastLine}`,
  `+// smoke: code-rsi end-to-end probe (safe to delete)`,
  ``,
].join("\n");

console.log(`[1/3] TS wall over the handcrafted patch (target: src/rsi/${target})`);
const parsed = parseUnifiedDiff(patch);
if (isDiffParseError(parsed)) throw new Error(`parser rejected the probe patch: ${parsed.error}`);
const wall = validateCodePatch(parsed);
if (!wall.ok) throw new Error(`wall rejected the probe patch: ${wall.reason}`);
console.log(`      wall: ok (files=${parsed.files.length}, +1/-0)`);

const head = (
  await bunExec(["git", "rev-parse", "HEAD"], { cwd: repoRoot, timeoutMs: 30_000 })
).stdout.trim();
console.log(`[2/3] disposable worktree at ${head.slice(0, 12)} — apply + install + FULL suite + tsc + build`);
const t0 = Date.now();
const r = await evaluateCodePatch({ patch, baseCommit: head }, { repoRoot });
if (!r.ok) {
  console.error(`      FAILED at ${r.stage}: ${r.reason}`);
  process.exit(1);
}
const m = r.measurements;
console.log(
  `      measurements: tests ${m.testsPassed} pass / ${m.testsFailed} fail (exit ${m.testsExitCode}) | ` +
    `tsc exit ${m.tscExitCode} | build exit ${m.buildExitCode} | ` +
    `${m.changedLines} changed lines | ${((Date.now() - t0) / 1000).toFixed(0)}s`,
);

console.log(`[3/3] score the locked Rust formula would produce (LOCAL RECONSTRUCTION, display only)`);
const passRate =
  m.testsPassed + m.testsFailed === 0 || m.testsExitCode !== 0
    ? 0
    : m.testsPassed / (m.testsPassed + m.testsFailed);
const score =
  100 *
  (0.6 * passRate +
    0.15 * (m.tscExitCode === 0 ? 1 : 0) +
    0.15 * (m.buildExitCode === 0 ? 1 : 0) +
    0.1 * Math.max(0, Math.min(1, 1 - m.changedLines / 200)));
console.log(`      score ≈ ${score.toFixed(1)} / 100`);
console.log(
  m.testsFailed === 0 && m.tscExitCode === 0 && m.buildExitCode === 0
    ? "SMOKE: PASS — the worktree pipeline is real end-to-end on this repo"
    : "SMOKE: MEASURED-BUT-RED — pipeline ran, candidate would be rejected",
);
