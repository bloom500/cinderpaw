/**
 * Faza 2 Slice 4 — code candidates through the live Contract FSM, pinned
 * over fake CodeStageDeps: stage table (wall / base + worktree / the Rust
 * verdict against the base / record), verdict per failure mode, the
 * approval queue, and the proposal operator's pure pieces.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeGenome } from "../src/rsi/l3-code/code-genome.ts";
import type { CodeEvalMeasurements, ExecFn } from "../src/rsi/l3-code/code-sandbox.ts";
import type { CodeJudgement, CodeStageDeps } from "../src/rsi/l3-code/code-leaves.ts";
import type { IsolationBackend } from "../src/rsi/l3-code/isolation.ts";
import { makeCodeStageAdapters, runCodeCandidate } from "../src/rsi/l3-code/code-rsi.ts";
import { PendingPatchStore } from "../src/rsi/l3-code/pending-patches.ts";
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
  patch: "--- a/src/rsi/l1-config/mutation.ts\n+++ b/src/rsi/l1-config/mutation.ts\n@@ -1 +1 @@\n-a\n+b\n",
  affectedFiles: ["src/rsi/l1-config/mutation.ts"],
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

/** Rust's verdict when the candidate is no worse than its base. */
const noWorse: CodeJudgement = { score: 90, baseScore: 88, tests: null, tsc: null, build: null, noWorse: true };

/** Fake stage deps: green by default, overridable per test; records calls. */
function fakeDeps(over: Partial<CodeStageDeps> = {}, calls: string[] = []) {
  const deps: CodeStageDeps = {
    validatePatch: async () => (calls.push("validate"), { ok: true }),
    measureBase: async () => (calls.push("base"), { ok: true, measurements: greenMeasurements }),
    evaluateInWorktree: async () => (
      calls.push("worktree"), { ok: true, measurements: greenMeasurements }
    ),
    judgePatch: async () => (calls.push("judge"), noWorse),
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

async function runWith(
  over: Partial<CodeStageDeps> = {},
  pop?: PopulationManager,
  pendingStore?: PendingPatchStore,
  genomeId = "g-1234",
) {
  const { deps, calls } = fakeDeps(over);
  const j = scratchJournal();
  try {
    const result = await runCodeCandidate({
      genomeId,
      genome,
      deps,
      journalPath: j.journalPath,
      ...(pop ? { pop } : {}),
      ...(pendingStore ? { pendingStore } : {}),
    });
    return { result, calls };
  } finally {
    j.cleanup();
  }
}

describe("runCodeCandidate — the code path through the live FSM", () => {
  test("green candidate: full stage sequence, accept, recorded", async () => {
    const pop = new PopulationManager();
    const { result, calls } = await runWith({}, pop);
    expect(result.decided?.action).toBe("accept");
    expect(result.advanced).toBe(true);
    expect(result.commitHash).toBe("deadbeef");
    expect(result.score).toBe(90);
    expect(result.previousBest).toBe(88); // the base's composite, not a bar
    // wall → base → worktree → Rust verdict → wall re-assert → commit → record
    expect(calls).toEqual(["validate", "base", "worktree", "judge", "validate", "commit", "ratchet"]);
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
    expect(calls).not.toContain("judge");
    expect(calls).not.toContain("commit");
  });

  test("no base measurement → halt with the reason, the candidate never runs", async () => {
    const { result, calls } = await runWith({
      measureBase: async () => ({ ok: false, stage: "isolation", reason: "Docker is not installed." }),
    });
    expect(result.decided?.action).toBe("halt");
    expect(result.decided?.reason).toContain("measuring the unpatched base");
    expect(result.decided?.reason).toContain("Docker is not installed.");
    expect(calls).not.toContain("worktree");
  });

  test("a test that does worse than on the base rejects at the suite floor", async () => {
    const { result, calls } = await runWith({
      judgePatch: async () => ({ ...noWorse, tests: "2 tests fail; the base fails 1", noWorse: false }),
    });
    expect(result.decided?.action).toBe("reject");
    expect(result.decided?.reason).toContain("worse than the base: 2 tests fail; the base fails 1");
    expect(calls).not.toContain("commit");
  });

  test("a test the base already fails does not reject the candidate", async () => {
    // The absolute rule rejected every candidate cut from a base with one
    // failing test. The verdict is Rust's, against the base.
    const oneFailing = { ...greenMeasurements, testsFailed: 1, testsExitCode: 1 };
    const { result } = await runWith({
      measureBase: async () => ({ ok: true, measurements: oneFailing }),
      evaluateInWorktree: async () => ({ ok: true, measurements: oneFailing }),
    });
    expect(result.decided?.action).toBe("accept");
  });

  test("tsc or build worse than the base rejects at regression, before any commit", async () => {
    for (const worse of [
      { tsc: "tsc --noEmit fails (exit 2); the base type-checks" },
      { build: "the build fails (exit 1); the base builds" },
    ]) {
      const { result, calls } = await runWith({
        judgePatch: async () => ({ ...noWorse, ...worse, noWorse: false }),
      });
      expect(result.decided?.action).toBe("reject");
      expect(result.decided?.reason).toContain(Object.values(worse)[0]!);
      expect(calls).not.toContain("commit");
    }
  });

  test("every candidate no worse than its base is queued, not only the first", async () => {
    // The absolute ratchet let one green one-liner through and refused every
    // patch after it, so nothing else ever reached a person.
    const dir = mkdtempSync(join(tmpdir(), "cinderpaw-pending-"));
    try {
      const store = new PendingPatchStore(join(dir, "pending.json"));
      await runWith({}, undefined, store, "g-first");
      await runWith({ judgePatch: async () => ({ ...noWorse, score: 70 }) }, undefined, store, "g-second");
      expect(store.list().map((p) => p.id)).toEqual(["g-first", "g-second"]);
      await runWith({ judgePatch: async () => ({ ...noWorse, tests: "worse", noWorse: false }) }, undefined, store, "g-worse");
      expect(store.list().map((p) => p.id)).toEqual(["g-first", "g-second"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe("makeCodeStageAdapters — the base and the Rust verdict", () => {
  /** A sandbox that runs nothing: git succeeds, every step prints `pass`. */
  function fakeSandbox(testsExit = 0) {
    const runs: string[] = [];
    const exec: ExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
    const isolation: IsolationBackend = {
      name: "fake",
      available: async () => ({ ok: true, note: "fake" }),
      run: async (_dir, steps) => (
        runs.push("run"),
        steps.map((st) => ({
          exitCode: st.name === "tests" ? testsExit : 0,
          stdout: "10 pass\n0 fail",
          stderr: "",
          timedOut: testsExit < 0,
        }))
      ),
    };
    return { sandbox: { exec, isolation }, runs };
  }

  test("the base is measured once per base commit, and a killed run is retried", async () => {
    const root = `C:/fake-${Math.random()}`;
    const { sandbox, runs } = fakeSandbox();
    const deps = makeCodeStageAdapters({ bridge: {} as RsiBridge, repoRoot: root, sandbox });
    const a = await deps.measureBase("base-1");
    await deps.measureBase("base-1");
    expect(a.ok && a.measurements.changedLines).toBe(0);
    expect(runs).toHaveLength(1);
    await deps.measureBase("base-2");
    expect(runs).toHaveLength(2);

    const killed = fakeSandbox(-2);
    const again = makeCodeStageAdapters({ bridge: {} as RsiBridge, repoRoot: `${root}-k`, sandbox: killed.sandbox });
    await again.measureBase("base-1");
    await again.measureBase("base-1");
    expect(killed.runs).toHaveLength(2);
  });

  test("judgePatch hands Rust both measurement sets and reads its verdict", async () => {
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const bridge = {
      request: async (method: string, params: Record<string, unknown>) => (
        sent.push({ method, params }),
        { candidate: { score: 90 }, base: { score: 95 }, tests: "1 tests fail; the base fails 0", tsc: null, build: null, no_worse: false }
      ),
    } as unknown as RsiBridge;
    const deps = makeCodeStageAdapters({ bridge, repoRoot: "C:/fake" });
    const j = await deps.judgePatch(greenMeasurements, { ...greenMeasurements, testsFailed: 1 });
    expect(sent[0]!.method).toBe("rsi_judge_code_patch");
    expect((sent[0]!.params.base as Record<string, number>).tests_failed).toBe(0);
    expect((sent[0]!.params.candidate as Record<string, number>).tests_failed).toBe(1);
    expect(j).toEqual({ score: 90, baseScore: 95, tests: "1 tests fail; the base fails 0", tsc: null, build: null, noWorse: false });
  });
});

describe("proposal operator — pure pieces", () => {
  test("proposableFiles offers only what the wall would let through", () => {
    const files = proposableFiles([
      "l1-config/mutation.ts",
      "l3-code/code-genome.ts", // denylisted
      "infra/ratchet-handler.ts", // denylisted
      "l1-config/notes.md", // wrong extension
      "l1-config/goal-mode.ts", // not on the allowlist
      "mutation.ts", // not the real path
      "l1-config/taste-miner.ts",
    ]);
    expect(files).toEqual(["l1-config/mutation.ts", "l1-config/taste-miner.ts"]);
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
        expect(user).toContain("src/rsi/l1-config/mutation.ts");
        return "RATIONALE: tighten a clamp\n```diff\n--- a/src/rsi/l1-config/mutation.ts\n+++ b/src/rsi/l1-config/mutation.ts\n@@ -1 +1 @@\n-a\n+b\n```";
      },
      listRsiFiles: async () => ["l1-config/mutation.ts", "code-genome.ts"],
      readRsiFile: async () => "export const a = 1;",
      baseCommit: async () => "head123",
      rng: () => 0, // deterministic: picks the first proposable file
    });
    expect(g).not.toBeNull();
    expect(g!.baseCommit).toBe("head123");
    expect(g!.affectedFiles).toEqual(["src/rsi/l1-config/mutation.ts"]);
    expect(g!.proposal.rationale).toBe("tighten a clamp");
  });

  test("parseEditBlocks: extracts SEARCH/REPLACE pairs; null on prose", () => {
    const text =
      "RATIONALE: x\n<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE\n";
    expect(parseEditBlocks(text)).toEqual([{ search: "const a = 1;", replace: "const a = 2;" }]);
    expect(parseEditBlocks("no blocks here")).toBeNull();
  });

  test("applyEditBlocks: a CRLF source takes an LF block and keeps CRLF (every rsi/ file on a Windows checkout)", () => {
    const src = "one\r\ntwo\r\nthree\r\n";
    expect(applyEditBlocks(src, [{ search: "two\nthree", replace: "2\n3" }])).toBe("one\r\n2\r\n3\r\n");
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
    const diff = buildUnifiedDiff(oldText, newText, "src/rsi/l1-config/mutation.ts");
    expect(diff).toContain("--- a/src/rsi/l1-config/mutation.ts");
    expect(diff).toContain("+++ b/src/rsi/l1-config/mutation.ts");
    expect(diff).toContain("-l4");
    expect(diff).toContain("+l4x");
    // The wall's parser must accept exactly what the serializer emits.
    const parsed = parseUnifiedDiff(diff!);
    expect("error" in parsed).toBe(false);
    // Identical texts → no diff.
    expect(buildUnifiedDiff(oldText, oldText, "src/rsi/l1-config/mutation.ts")).toBeNull();
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
      listRsiFiles: async () => ["l1-config/mutation.ts"],
      readRsiFile: async () => source,
      baseCommit: async () => "h",
      rng: () => 0,
    });
    expect(g).not.toBeNull();
    expect(g!.patch).toContain("-line2");
    expect(g!.patch).toContain("+line2-improved");
    expect(g!.affectedFiles).toEqual(["src/rsi/l1-config/mutation.ts"]);
    const parsed = parseUnifiedDiff(g!.patch);
    expect("error" in parsed).toBe(false);
  });

  test("proposeCodePatch: hallucinated SEARCH text → null, not a broken patch", async () => {
    const g = await proposeCodePatch({
      completeLocal: async () =>
        "RATIONALE: x\n<<<<<<< SEARCH\nthis text is not in the file\n=======\nnew\n>>>>>>> REPLACE\n",
      listRsiFiles: async () => ["l1-config/mutation.ts"],
      readRsiFile: async () => "real content\n",
      baseCommit: async () => "h",
      rng: () => 0,
    });
    expect(g).toBeNull();
  });

  test("proposeCodePatch: SKIP and diff-less output → null, not an error", async () => {
    const base = {
      listRsiFiles: async () => ["l1-config/mutation.ts"],
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
