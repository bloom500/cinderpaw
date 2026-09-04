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
import type { CodeGenome } from "../src/rsi/l3-code/code-genome.ts";
import type { CodeEvalMeasurements } from "../src/rsi/l3-code/code-sandbox.ts";
import type { CodeStageDeps } from "../src/rsi/l3-code/code-leaves.ts";
import { makeCodeStageAdapters, runCodeCandidate } from "../src/rsi/l3-code/code-rsi.ts";
import type { RsiBridge } from "../src/rsi/infra/bridge.ts";
import { PopulationManager } from "../src/rsi/l1-config/population-manager.ts";
import {
  affectedFilesOf,
  applyEditBlocks,
  buildUnifiedDiff,
  extractUnifiedDiff,
  parseEditBlocks,
  proposableFiles,
  proposeCodePatch,
} from "../src/rsi/l3-code/code-proposer.ts";
import { parseUnifiedDiff } from "../src/rsi/l3-code/code-genome.ts";

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

/** Every test journals to a scratch file — NEVER the production ~/.cinderpaw. */
function scratchJournal() {
  const dir = mkdtempSync(join(tmpdir(), "cinderpaw-code-rsi-test-"));
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

describe("makeCodeStageAdapters.validatePatch — both walls, in order", () => {
  function bridgeStub(responses: Record<string, unknown>, calls: string[] = []) {
    const bridge = {
      request: async (method: string) => (calls.push(method), responses[method]),
    } as unknown as RsiBridge;
    return { bridge, calls };
  }

  test("TS wall rejects in-process; the bridge is never consulted", async () => {
    const { bridge, calls } = bridgeStub({});
    const deps = makeCodeStageAdapters({ bridge, repoRoot: "C:/fake" });
    // Policy-violating patch (outside src/rsi/) that parses fine.
    const v = await deps.validatePatch(
      "--- a/src/agent-loop.ts\n+++ b/src/agent-loop.ts\n@@ -1 +1 @@\n-a\n+b\n",
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("outside");
    expect(calls).toEqual([]);
    // Unparseable input is also caught locally, as a verdict.
    const p = await deps.validatePatch("not a diff");
    expect(p.ok).toBe(false);
    expect(p.reason).toContain("parse");
    expect(calls).toEqual([]);
  });

  test("a TS-clean patch still needs the Rust wall's word", async () => {
    const good = genome.patch;
    const { bridge, calls } = bridgeStub({ rsi_validate_code_patch: { ok: true } });
    const deps = makeCodeStageAdapters({ bridge, repoRoot: "C:/fake" });
    expect((await deps.validatePatch(good)).ok).toBe(true);
    expect(calls).toEqual(["rsi_validate_code_patch"]);

    const { bridge: denyBridge } = bridgeStub({
      rsi_validate_code_patch: { ok: false, reason: "rust says no" },
    });
    const denied = await makeCodeStageAdapters({ bridge: denyBridge, repoRoot: "C:/fake" })
      .validatePatch(good);
    expect(denied).toEqual({ ok: false, reason: "rust says no" });
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

  test("parseEditBlocks: extracts SEARCH/REPLACE pairs; null on prose", () => {
    const text =
      "RATIONALE: x\n<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE\n";
    expect(parseEditBlocks(text)).toEqual([{ search: "const a = 1;", replace: "const a = 2;" }]);
    expect(parseEditBlocks("no blocks here")).toBeNull();
  });

  test("applyEditBlocks: unique match applies; missing or ambiguous → null", () => {
    const src = "one\ntwo\nthree\n";
    expect(applyEditBlocks(src, [{ search: "two", replace: "2" }])).toBe("one\n2\nthree\n");
    expect(applyEditBlocks(src, [{ search: "missing", replace: "x" }])).toBeNull();
    expect(applyEditBlocks("dup\ndup\n", [{ search: "dup", replace: "x" }])).toBeNull();
    // A no-op edit yields no candidate rather than an empty diff.
    expect(applyEditBlocks(src, [{ search: "two", replace: "two" }])).toBeNull();
  });

  test("buildUnifiedDiff: single hunk with context that the TS wall parses", () => {
    const oldText = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n";
    const newText = "l1\nl2\nl3\nl4x\nl5\nl6\nl7\nl8\n";
    const diff = buildUnifiedDiff(oldText, newText, "src/rsi/mutation.ts");
    expect(diff).toContain("--- a/src/rsi/mutation.ts");
    expect(diff).toContain("+++ b/src/rsi/mutation.ts");
    expect(diff).toContain("-l4");
    expect(diff).toContain("+l4x");
    // The wall's parser must accept exactly what the serializer emits.
    const parsed = parseUnifiedDiff(diff!);
    expect("error" in parsed).toBe(false);
    // Identical texts → no diff.
    expect(buildUnifiedDiff(oldText, oldText, "src/rsi/mutation.ts")).toBeNull();
  });

  test("buildUnifiedDiff: edits at file top and bottom keep valid hunks", () => {
    const oldText = "a\nb\nc\n";
    for (const newText of ["A\nb\nc\n", "a\nb\nC\n", "x\na\nb\nc\n", "a\nb\n"]) {
      const diff = buildUnifiedDiff(oldText, newText, "src/rsi/x.ts");
      expect(diff).not.toBeNull();
      const parsed = parseUnifiedDiff(diff!);
      expect("error" in parsed).toBe(false);
    }
  });

  test("proposeCodePatch: SEARCH/REPLACE output becomes a serialized diff", async () => {
    const source = "line1\nline2\nline3\nline4\n";
    const g = await proposeCodePatch({
      completeLocal: async () =>
        "RATIONALE: tighten\n<<<<<<< SEARCH\nline2\n=======\nline2-improved\n>>>>>>> REPLACE\n",
      listRsiFiles: async () => ["mutation.ts"],
      readRsiFile: async () => source,
      baseCommit: async () => "h",
      rng: () => 0,
    });
    expect(g).not.toBeNull();
    expect(g!.patch).toContain("-line2");
    expect(g!.patch).toContain("+line2-improved");
    expect(g!.affectedFiles).toEqual(["src/rsi/mutation.ts"]);
    const parsed = parseUnifiedDiff(g!.patch);
    expect("error" in parsed).toBe(false);
  });

  test("proposeCodePatch: hallucinated SEARCH text → null, not a broken patch", async () => {
    const g = await proposeCodePatch({
      completeLocal: async () =>
        "RATIONALE: x\n<<<<<<< SEARCH\nthis text is not in the file\n=======\nnew\n>>>>>>> REPLACE\n",
      listRsiFiles: async () => ["mutation.ts"],
      readRsiFile: async () => "real content\n",
      baseCommit: async () => "h",
      rng: () => 0,
    });
    expect(g).toBeNull();
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
