/**
 * Faza 2 Slice 4 — code candidates through the live Contract FSM, pinned
 * over fake CodeStageDeps: stage table (wall / worktree / suite floor /
 * Rust score / tsc regression / ratchet), verdict per failure mode, and
 * the proposal operator's pure pieces.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeGenome } from "../src/rsi/code-genome.ts";
import type { CodeEvalMeasurements } from "../src/rsi/code-sandbox.ts";
import type { CodeStageDeps } from "../src/rsi/code-leaves.ts";
import { runCodeCandidate } from "../src/rsi/code-rsi.ts";
import { PopulationManager } from "../src/rsi/population-manager.ts";
import {
  affectedFilesOf,
  extractUnifiedDiff,
  proposableFiles,
  proposeCodePatch,
} from "../src/rsi/code-proposer.ts";

const genome: CodeGenome = {
  patch: "--- a/src/rsi/mutation.ts\n+++ b/src/rsi/mutation.ts\n@@ -1 +1 @@\n-a\n+b\n",
  affectedFiles: ["src/rsi/mutation.ts"],
  baseCommit: "base123",
  proposal: { rationale: "r", riskAssessment: "ra", testPlan: "tp" },
};

const greenMeasurements: CodeEvalMeasurements = {
  testsPassed: 100,
  testsFailed: 0,
  testsExitCode: 0,
  tscExitCode: 0,
  buildExitCode: 0,
  changedLines: 2,
  durationMs: 1,
};

/** Fake stage deps: green by default, overridable per test; records calls. */
function fakeDeps(over: Partial<CodeStageDeps> = {}, calls: string[] = []) {
  const deps: CodeStageDeps = {
    validatePatch: async () => (calls.push("validate"), { ok: true }),
    evaluateInWorktree: async () => (
      calls.push("worktree"), { ok: true, measurements: greenMeasurements }
    ),
    scorePatch: async () => (calls.push("score"), { score: 90 }),
    commitCodePatch: async () => (calls.push("commit"), { commitHash: "deadbeef" }),
    ratchetAttempt: async () => (calls.push("ratchet"), { advanced: true, previousBest: 50 }),
    ...over,
  };
  return { deps, calls };
}

/** Every test journals to a scratch file — NEVER the production ~/.feral. */
function scratchJournal() {
  const dir = mkdtempSync(join(tmpdir(), "feral-code-rsi-test-"));
  return { journalPath: () => join(dir, "journal.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function runWith(over: Partial<CodeStageDeps> = {}, pop?: PopulationManager) {
  const { deps, calls } = fakeDeps(over);
  const j = scratchJournal();
  try {
    const result = await runCodeCandidate({
      genomeId: "g-1234",
      genome,
      deps,
      journalPath: j.journalPath,
      ...(pop ? { pop } : {}),
    });
    return { result, calls };
  } finally {
    j.cleanup();
  }
}

describe("runCodeCandidate — the code path through the live FSM", () => {
  test("green candidate: full stage sequence, accept, ratchet advanced", async () => {
    const pop = new PopulationManager();
    const { result, calls } = await runWith({}, pop);
    expect(result.decided?.action).toBe("accept");
    expect(result.advanced).toBe(true);
    expect(result.commitHash).toBe("deadbeef");
    expect(result.score).toBe(90);
    // wall → worktree → score → wall re-assert → commit → ratchet
    expect(calls).toEqual(["validate", "worktree", "score", "validate", "commit", "ratchet"]);
    // Population carries the code genome + its substrate commit.
    expect(pop.get("g-1234")?.code?.patch).toBe(genome.patch);
    expect(pop.getCommitHash("g-1234")).toBe("deadbeef");
  });

  test("wall reject → static_analysis reject, worktree never runs", async () => {
    const { result, calls } = await runWith({
      validatePatch: async () => ({ ok: false, reason: "file outside src/rsi/" }),
    });
    expect(result.decided?.action).toBe("reject");
    expect(calls).not.toContain("worktree");
    expect(calls).not.toContain("commit");
  });

  test("worktree infra failure → hard halt, nothing downstream", async () => {
    const { result, calls } = await runWith({
      evaluateInWorktree: async () => ({
        ok: false,
        stage: "patch_apply",
        reason: "does not apply",
      }),
    });
    expect(result.decided?.action).toBe("halt");
    expect(calls).not.toContain("score");
    expect(calls).not.toContain("commit");
  });

  test("a failing test in the patched copy rejects at the suite floor", async () => {
    const { result, calls } = await runWith({
      evaluateInWorktree: async () => ({
        ok: true,
        measurements: { ...greenMeasurements, testsFailed: 1, testsExitCode: 1 },
      }),
    });
    expect(result.decided?.action).toBe("reject");
    expect(result.decided?.reason).toContain("tests failed");
    expect(calls).not.toContain("commit");
  });

  test("dirty tsc rejects at regression, before any commit", async () => {
    const { result, calls } = await runWith({
      evaluateInWorktree: async () => ({
        ok: true,
        measurements: { ...greenMeasurements, tscExitCode: 2 },
      }),
    });
    expect(result.decided?.action).toBe("reject");
    expect(result.decided?.reason).toContain("tsc");
    expect(calls).not.toContain("commit");
  });

  test("ratchet decline is a soft reject with the commit still recorded", async () => {
    const { result } = await runWith({
      ratchetAttempt: async () => ({ advanced: false, previousBest: 95 }),
    });
    expect(result.decided?.action).toBe("reject");
    expect(result.advanced).toBe(false);
    expect(result.commitHash).toBe("deadbeef"); // substrate commit happened
  });
});

describe("proposal operator — pure pieces", () => {
  test("proposableFiles excludes the enforcement chain and non-.ts", () => {
    const files = proposableFiles([
      "mutation.ts",
      "code-genome.ts", // denylisted
      "ratchet-handler.ts", // denylisted
      "notes.md", // wrong extension
      "taste-miner.ts",
    ]);
    expect(files).toEqual(["mutation.ts", "taste-miner.ts"]);
  });

  test("extractUnifiedDiff prefers the fenced block", () => {
    const text = "RATIONALE: x\n```diff\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n+b\n```\ntrailing";
    expect(extractUnifiedDiff(text)).toBe("--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n+b\n");
  });

  test("extractUnifiedDiff falls back to a bare diff and rejects prose", () => {
    const bare = "some preamble\ndiff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n+b";
    expect(extractUnifiedDiff(bare)).toContain("diff --git");
    expect(extractUnifiedDiff("no diff here at all")).toBeNull();
  });

  test("affectedFilesOf strips prefixes and skips /dev/null", () => {
    const patch =
      "--- a/src/rsi/x.ts\n+++ b/src/rsi/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ b/src/rsi/y.ts\n@@ -0,0 +1 @@\n+n\n";
    expect(affectedFilesOf(patch)).toEqual(["src/rsi/x.ts", "src/rsi/y.ts"]);
  });

  test("proposeCodePatch: end-to-end over fake deps", async () => {
    const g = await proposeCodePatch({
      completeLocal: async ({ user }) => {
        expect(user).toContain("src/rsi/mutation.ts");
        return "RATIONALE: tighten a clamp\n```diff\n--- a/src/rsi/mutation.ts\n+++ b/src/rsi/mutation.ts\n@@ -1 +1 @@\n-a\n+b\n```";
      },
      listRsiFiles: async () => ["mutation.ts", "code-genome.ts"],
      readRsiFile: async () => "export const a = 1;",
      baseCommit: async () => "head123",
      rng: () => 0, // deterministic: picks the first proposable file
    });
    expect(g).not.toBeNull();
    expect(g!.baseCommit).toBe("head123");
    expect(g!.affectedFiles).toEqual(["src/rsi/mutation.ts"]);
    expect(g!.proposal.rationale).toBe("tighten a clamp");
  });

  test("proposeCodePatch: SKIP and diff-less output → null, not an error", async () => {
    const base = {
      listRsiFiles: async () => ["mutation.ts"],
      readRsiFile: async () => "x",
      baseCommit: async () => "h",
      rng: () => 0,
    };
    expect(await proposeCodePatch({ ...base, completeLocal: async () => "SKIP" })).toBeNull();
    expect(
      await proposeCodePatch({ ...base, completeLocal: async () => "I think it's fine." }),
    ).toBeNull();
  });
});
