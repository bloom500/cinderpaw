/**
 * shell_exec + git_* tools — integration tests.
 *
 * Tests build a real git repo in a tmpdir, run the tools against it,
 * and assert on the structured result. shell_exec tests use `git init`
 * and `git log` to verify the sandbox path works end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createShellExecTool } from "../src/tools/builtin/shell-exec.ts";
import {
  createGitStatusTool, createGitDiffTool, createGitLogTool,
  createGitCommitTool, createGitBranchTool,
} from "../src/tools/builtin/git.ts";
import { AuditLog } from "../src/sandbox/audit-log.ts";
import { openDatabase } from "../src/db.ts";
import { EgressProxy } from "../src/sandbox/egress-proxy.ts";
import { RealProcessSandbox } from "../src/sandbox/process-sandbox.ts";
import type { ToolContext } from "../src/types.ts";

function makeCtx(allowedPaths: string[]): { ctx: ToolContext; cleanup: () => void } {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const procSandbox = new RealProcessSandbox(audit.logger);
  const ctx: ToolContext = {
    sessionId: "test",
    manifest: {
      name: "test",
      description: "test",
      permissions: ["fs:read", "fs:write", "process:spawn"],
      networkAccess: false,
      allowedPaths,
      allowedExecutables: ["sh", "cmd", "git"],
    },
    fetch: egress.forTool(
      { name: "test", description: "test", permissions: [], networkAccess: false },
      "test",
    ),
    audit: audit.logger,
    process: procSandbox,
  };
  return { ctx, cleanup: () => db.close() };
}

async function initRepo(repoDir: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const p = spawn("git", ["init", "-q"], { cwd: repoDir });
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`git init exited ${code}`)));
    p.on("error", reject);
  });
  // Configure a local user so commits work without a global git config.
  await new Promise<void>((resolve, reject) => {
    const p = spawn("git", ["config", "user.email", "test@feral"], { cwd: repoDir });
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`git config email exited ${code}`)));
    p.on("error", reject);
  });
  await new Promise<void>((resolve, reject) => {
    const p = spawn("git", ["config", "user.name", "Feral Test"], { cwd: repoDir });
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`git config name exited ${code}`)));
    p.on("error", reject);
  });
}

describe("shell_exec (argv-only)", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "feral-shell-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("runs an allowlisted binary via argv and captures stdout", async () => {
    const tool = createShellExecTool([tmp]);
    const { ctx, cleanup } = makeCtx([tmp]);
    try {
      const result = await tool.execute({ argv: ["git", "--version"] }, ctx);
      expect(result.ok).toBe(true);
      const data = result.data as { stdout: string; exitCode: number };
      expect(data.exitCode).toBe(0);
      expect(data.stdout.toLowerCase()).toContain("git version");
    } finally { cleanup(); }
  });

  it("accepts the legacy command string by tokenizing it (no shell)", async () => {
    const tool = createShellExecTool([tmp]);
    const { ctx, cleanup } = makeCtx([tmp]);
    try {
      const result = await tool.execute({ command: "git --version" }, ctx);
      expect(result.ok).toBe(true);
      expect((result.data as { stdout: string }).stdout.toLowerCase()).toContain("git version");
    } finally { cleanup(); }
  });

  it("propagates non-zero exit codes", async () => {
    const tool = createShellExecTool([tmp]);
    const { ctx, cleanup } = makeCtx([tmp]);
    try {
      // Unknown flag → git exits non-zero. No shell `exit` builtin needed.
      const result = await tool.execute({ argv: ["git", "--this-flag-does-not-exist"] }, ctx);
      expect(result.ok).toBe(false);
      expect((result.data as { exitCode: number }).exitCode).not.toBe(0);
    } finally { cleanup(); }
  });

  it("does NOT interpret shell metacharacters — `&&` cannot chain a second command", async () => {
    const tool = createShellExecTool([tmp]);
    const { ctx, cleanup } = makeCtx([tmp]);
    try {
      // Pre-V2, this string went through `cmd /c` / `sh -c` and `echo pwned`
      // ran as a chained command. Now the whole thing is argv to git, which
      // never spawns a second process — the marker must not appear.
      const result = await tool.execute(
        { command: "git --version && echo pwned-marker" },
        ctx,
      );
      const data = result.data as { stdout: string; stderr: string };
      expect(`${data.stdout}${data.stderr}`).not.toContain("pwned-marker");
    } finally { cleanup(); }
  });

  it("rejects a non-whitelisted binary", async () => {
    const tool = createShellExecTool([tmp]);
    const { ctx, cleanup } = makeCtx([tmp]);
    try {
      const result = await tool.execute({ argv: ["rm", "-rf", tmp] }, ctx);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("binary_not_whitelisted");
    } finally { cleanup(); }
  });
});

describe("git tools (integration)", () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "feral-git-"));
    await initRepo(repo);
  });
  // maxRetries/retryDelay: Windows holds EBUSY locks briefly after git exits.
  afterEach(() => { rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

  it("git_status on a clean repo returns no changes", async () => {
    const tool = createGitStatusTool([repo]);
    const { ctx, cleanup } = makeCtx([repo]);
    try {
      const result = await tool.execute({ path: repo }, ctx);
      expect(result.ok).toBe(true);
      const data = result.data as { stdout: string };
      // No tracked file → no entries. The branch header is the only line.
      expect(data.stdout.trim().split("\n").length).toBeLessThanOrEqual(2);
    } finally { cleanup(); }
  });

  it("git_status reports an untracked file", async () => {
    writeFileSync(join(repo, "hello.txt"), "hello\n");
    const tool = createGitStatusTool([repo]);
    const { ctx, cleanup } = makeCtx([repo]);
    try {
      const result = await tool.execute({ path: repo }, ctx);
      expect(result.ok).toBe(true);
      const data = result.data as { stdout: string };
      expect(data.stdout).toContain("hello.txt");
    } finally { cleanup(); }
  });

  it("git_commit blocks the --push flag embedded in a message", async () => {
    writeFileSync(join(repo, "x.txt"), "x");
    const tool = createGitCommitTool([repo]);
    const { ctx, cleanup } = makeCtx([repo]);
    try {
      const result = await tool.execute(
        { path: repo, message: "feat: cool thing --push origin main" },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(result.error).toBe("forbidden_flag");
    } finally { cleanup(); }
  });

  it("git_commit actually creates a commit when safe", async () => {
    writeFileSync(join(repo, "x.txt"), "x");
    const tool = createGitCommitTool([repo]);
    const { ctx, cleanup } = makeCtx([repo]);
    try {
      const result = await tool.execute(
        { path: repo, message: "first commit\n\nBody line.", add_all: true },
        ctx,
      );
      expect(result.ok).toBe(true);
      // Verify with a follow-up git log.
      const log = createGitLogTool([repo]);
      const logResult = await log.execute({ path: repo, max: 1 }, ctx);
      expect(logResult.ok).toBe(true);
      const data = logResult.data as { stdout: string };
      expect(data.stdout).toContain("first commit");
    } finally { cleanup(); }
  }, 20_000);

  it("git_log shows the last N commits", async () => {
    writeFileSync(join(repo, "x.txt"), "x");
    const c1 = createGitCommitTool([repo]);
    const { ctx, cleanup } = makeCtx([repo]);
    try {
      await c1.execute({ path: repo, message: "c1", add_all: true }, ctx);
      writeFileSync(join(repo, "y.txt"), "y");
      await c1.execute({ path: repo, message: "c2", add_all: true }, ctx);
      const log = createGitLogTool([repo]);
      const r = await log.execute({ path: repo, max: 5 }, ctx);
      expect(r.ok).toBe(true);
      const data = r.data as { stdout: string };
      expect(data.stdout).toContain("c1");
      expect(data.stdout).toContain("c2");
    } finally { cleanup(); }
  }, 20_000);

  it("git_diff shows unstaged changes", async () => {
    writeFileSync(join(repo, "x.txt"), "first\n");
    const c = createGitCommitTool([repo]);
    const { ctx, cleanup } = makeCtx([repo]);
    try {
      await c.execute({ path: repo, message: "init", add_all: true }, ctx);
      // Now modify the file and check the diff.
      writeFileSync(join(repo, "x.txt"), "second\n");
      const d = createGitDiffTool([repo]);
      const r = await d.execute({ path: repo, max_lines: 50 }, ctx);
      expect(r.ok).toBe(true);
      const data = r.data as { stdout: string };
      expect(data.stdout).toContain("-first");
      expect(data.stdout).toContain("+second");
    } finally { cleanup(); }
  }, 20_000);

  it("git_branch list works and create+switch works", async () => {
    writeFileSync(join(repo, "x.txt"), "x");
    const c = createGitCommitTool([repo]);
    const b = createGitBranchTool([repo]);
    const { ctx, cleanup } = makeCtx([repo]);
    try {
      await c.execute({ path: repo, message: "init", add_all: true }, ctx);
      // List
      const list = await b.execute({ path: repo, action: "list" }, ctx);
      expect(list.ok).toBe(true);
      // Create
      const create = await b.execute({ path: repo, action: "create", name: "feature" }, ctx);
      expect(create.ok).toBe(true);
      // Switch
      const switchRes = await b.execute({ path: repo, action: "switch", name: "master" }, ctx);
      expect(switchRes.ok).toBe(true);
    } finally { cleanup(); }
  }, 20_000);
});
