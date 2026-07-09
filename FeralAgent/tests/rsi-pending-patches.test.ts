/**
 * Faza 2 Slice 5 — the approval gate: queue lifecycle, first-10 window,
 * apply-time wall re-check, live apply/revert over a fake exec, and
 * persistence discipline (corrupt file → empty, never throw).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeGenome } from "../src/rsi/l3-code/code-genome.ts";
import type { ExecFn, ExecResult } from "../src/rsi/l3-code/code-sandbox.ts";
import {
  APPROVALS_BEFORE_AUTO,
  PendingPatchStore,
  applyPatchLive,
  revertPatchLive,
} from "../src/rsi/l3-code/pending-patches.ts";

const genome: CodeGenome = {
  patch: "--- a/src/rsi/l1-config/mutation.ts\n+++ b/src/rsi/l1-config/mutation.ts\n@@ -1 +1 @@\n-a\n+b\n",
  affectedFiles: ["src/rsi/l1-config/mutation.ts"],
  baseCommit: "base123",
  proposal: { rationale: "r", riskAssessment: "ra", testPlan: "tp" },
};

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "feral-pending-test-"));
  return { file: join(dir, "pending.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const okExec: ExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
function failingExec(stderr: string): ExecFn {
  return async (): Promise<ExecResult> => ({ exitCode: 1, stdout: "", stderr, timedOut: false });
}

describe("PendingPatchStore", () => {
  test("add → resolve → persistence round-trip across instances", () => {
    const s = scratch();
    try {
      const store = new PendingPatchStore(s.file);
      store.add({ id: "g1", genome, score: 90, commitHash: "abc" });
      store.add({ id: "g1", genome, score: 90, commitHash: "abc" }); // idempotent
      store.add({ id: "g2", genome, score: 80, commitHash: "def" });
      store.resolve("g2", "reject");

      const reloaded = new PendingPatchStore(s.file);
      expect(reloaded.list().map((p) => [p.id, p.status])).toEqual([
        ["g1", "pending"],
        ["g2", "rejected"],
      ]);
    } finally {
      s.cleanup();
    }
  });

  test("corrupt or wrong-version file → empty store, no throw", () => {
    const s = scratch();
    try {
      writeFileSync(s.file, "{not json");
      expect(new PendingPatchStore(s.file).list()).toEqual([]);
      writeFileSync(s.file, JSON.stringify({ version: 99, patches: [{}] }));
      expect(new PendingPatchStore(s.file).list()).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  test("resolve is pending-only; double resolution is a caller bug", () => {
    const s = scratch();
    try {
      const store = new PendingPatchStore(s.file);
      store.add({ id: "g1", genome, score: 90, commitHash: "abc" });
      store.resolve("g1", "approve");
      expect(() => store.resolve("g1", "approve")).toThrow("not pending");
      expect(() => store.resolve("ghost", "approve")).toThrow("unknown");
    } finally {
      s.cleanup();
    }
  });

  test("the first-10 window counts APPLIED patches (reverted included)", () => {
    const s = scratch();
    try {
      const store = new PendingPatchStore(s.file);
      expect(store.requiresManualApproval()).toBe(true);
      for (let i = 0; i < APPROVALS_BEFORE_AUTO; i++) {
        const id = `g${i}`;
        store.add({ id, genome, score: 50 + i, commitHash: `c${i}` });
        store.resolve(id, "approve");
        store.markApplied(id);
      }
      store.markReverted("g0"); // still counts — a human saw it
      expect(store.appliedCount()).toBe(APPROVALS_BEFORE_AUTO);
      expect(store.requiresManualApproval()).toBe(false);
    } finally {
      s.cleanup();
    }
  });
});

describe("applyPatchLive / revertPatchLive", () => {
  function approved(file: string, id = "g1") {
    const store = new PendingPatchStore(file);
    store.add({ id, genome, score: 90, commitHash: "abc" });
    store.resolve(id, "approve");
    return store;
  }

  test("approved patch applies: check then apply, from the repo root", async () => {
    const s = scratch();
    try {
      const calls: string[][] = [];
      const exec: ExecFn = async (cmd) => (calls.push(cmd), okExec(cmd, { cwd: "", timeoutMs: 0 }));
      const store = approved(s.file);
      const r = await applyPatchLive({ store, id: "g1", repoRoot: "C:/repo", exec });
      expect(r.ok).toBe(true);
      expect(store.get("g1")?.status).toBe("applied");
      expect(calls.length).toBe(2);
      expect(calls[0]).toContain("--check");
      expect(calls[0]).toContain("--directory=FeralAgent");
      expect(calls[1]).not.toContain("--check");
    } finally {
      s.cleanup();
    }
  });

  test("unapproved patches never touch git", async () => {
    const s = scratch();
    try {
      const store = new PendingPatchStore(s.file);
      store.add({ id: "g1", genome, score: 90, commitHash: "abc" });
      let execCalled = false;
      const exec: ExecFn = async () => ((execCalled = true), okExec([], { cwd: "", timeoutMs: 0 }));
      const r = await applyPatchLive({ store, id: "g1", repoRoot: "C:/repo", exec });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("not approved");
      expect(execCalled).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("apply-time wall re-check: a policy-violating patch is refused even if approved", async () => {
    const s = scratch();
    try {
      const store = new PendingPatchStore(s.file);
      store.add({
        id: "evil",
        genome: {
          ...genome,
          patch: "--- a/src/agent-loop.ts\n+++ b/src/agent-loop.ts\n@@ -1 +1 @@\n-a\n+b\n",
        },
        score: 99,
        commitHash: "abc",
      });
      store.resolve("evil", "approve");
      let execCalled = false;
      const exec: ExecFn = async () => ((execCalled = true), okExec([], { cwd: "", timeoutMs: 0 }));
      const r = await applyPatchLive({ store, id: "evil", repoRoot: "C:/repo", exec });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("outside");
      expect(execCalled).toBe(false);
      expect(store.get("evil")?.status).toBe("apply_failed");
    } finally {
      s.cleanup();
    }
  });

  test("git refusal → apply_failed with the reason, store consistent", async () => {
    const s = scratch();
    try {
      const store = approved(s.file);
      const r = await applyPatchLive({
        store,
        id: "g1",
        repoRoot: "C:/repo",
        exec: failingExec("error: patch does not apply"),
      });
      expect(r).toEqual({ ok: false, reason: "error: patch does not apply" });
      expect(store.get("g1")?.status).toBe("apply_failed");
    } finally {
      s.cleanup();
    }
  });

  test("revert reverse-applies an APPLIED patch and only that", async () => {
    const s = scratch();
    try {
      const calls: string[][] = [];
      const exec: ExecFn = async (cmd) => (calls.push(cmd), okExec(cmd, { cwd: "", timeoutMs: 0 }));
      const store = approved(s.file);
      // Not applied yet → refuse.
      let r = await revertPatchLive({ store, id: "g1", repoRoot: "C:/repo", exec });
      expect(r.ok).toBe(false);
      await applyPatchLive({ store, id: "g1", repoRoot: "C:/repo", exec });
      r = await revertPatchLive({ store, id: "g1", repoRoot: "C:/repo", exec });
      expect(r.ok).toBe(true);
      expect(store.get("g1")?.status).toBe("reverted");
      // The revert calls carry -R.
      const revertCalls = calls.slice(2);
      expect(revertCalls.every((c) => c.includes("-R"))).toBe(true);
    } finally {
      s.cleanup();
    }
  });
});
