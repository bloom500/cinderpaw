/**
 * git_* tools — read-mostly wrappers around the `git` CLI.
 *
 * Five small tools, all built on the same shared helper that runs
 * `git <args>` inside the sandbox. `git_commit` is the only one that
 * mutates repository state, and it has hard-coded blocks against
 * `--push`, `--force`, `--amend`, and `--no-verify` so the agent can
 * never accidentally push to a remote or rewrite history through this
 * surface.
 *
 * The allowed executable is resolved to an absolute path at module load
 * time (F0.5 hardening): a malicious `git` placed earlier in PATH can no
 * longer shadow the real one because the ProcessSandbox matches by
 * absolute path (Case B), not by basename+PATH-walk (Case C).
 */

import type { Tool, ToolManifest, ProcessRunResult } from "../../types.ts";
import { resolveExecutables } from "../../core/executables.ts";
import { firstAllowedPath } from "../../egress/tool-permissions.ts";

const GIT_ALLOWED = resolveExecutables(["git"]);

/**
 * Resolve the repo path: use the caller's `path` when given, otherwise fall
 * back to the first configured workspace root. Models routinely call git_*
 * with no path or a relative `.` — both used to surface as `spawn_error`
 * (the sandbox rejects a relative/out-of-root cwd). Defaulting to the
 * workspace root makes the common "git status of my project" call just work.
 */
function repoPath(
  args: Record<string, unknown>,
  manifest: ToolManifest,
): string | null {
  const p = args.path;
  if (typeof p === "string" && p.trim()) return p;
  return firstAllowedPath(manifest) ?? null;
}

const PATH_PARAM = {
  type: "string" as const,
  description:
    "Absolute path to a git repo (root or any subdir). Optional — defaults to the workspace root.",
  required: false,
};

interface ProcessCtx {
  process?: import("../../types.ts").ProcessSandbox;
  manifest: ToolManifest;
  sessionId: string;
}

async function runGit(
  ctx: ProcessCtx,
  args: string[],
  cwd: string,
  timeoutMs?: number,
  stdin?: string,
): Promise<ProcessRunResult> {
  if (!ctx.process) {
    throw new Error("git_* tool: process sandbox unavailable");
  }
  return ctx.process.run(ctx.manifest, ctx.sessionId, {
    executable: "git",
    args,
    cwd,
    timeoutMs,
    stdin,
  });
}

function format(result: ProcessRunResult, hint: string): { ok: boolean; content: string; data: unknown } {
  const ok = result.exitCode === 0 && !result.timedOut;
  const header = `[exit ${result.exitCode}` +
    (result.timedOut ? ", timed out" : "") +
    (result.outputTruncated ? ", truncated" : "") +
    `, ${result.durationMs}ms] ${hint}\n`;
  const out = result.stdout ? `${result.stdout}\n` : "";
  const err = result.stderr ? `[stderr]\n${result.stderr}\n` : "";
  return { ok, content: `${header}${out}${err}`, data: result };
}

function badArgs(msg: string): { ok: false; content: string; error: string } {
  return { ok: false, content: msg, error: "bad_args" };
}

function spawnError(err: unknown, tool: string): { ok: false; content: string; error: string } {
  return { ok: false, content: `${tool} failed: ${String((err as Error).message ?? err)}`, error: "spawn_error" };
}

// ───────────────────────────────────────────────────────────────────────
// git_status
// ───────────────────────────────────────────────────────────────────────

export function createGitStatusTool(allowedPaths: string[]): Tool {
  const manifest: ToolManifest = {
    name: "git_status",
    description:
      "Show the working tree status (porcelain v1). Output is the same " +
      "as `git status --porcelain` plus a short `git status -sb` summary line.",
    permissions: ["process:spawn", "fs:read"],
    networkAccess: false,
    allowedPaths,
    allowedExecutables: GIT_ALLOWED,
  };
  return {
    manifest,
    parameters: {
      path: PATH_PARAM,
    },
    async execute(args, ctx) {
      const path = repoPath(args, ctx.manifest);
      if (!path) {
        return badArgs("git_status: no 'path' given and no workspace root configured.");
      }
      try {
        const r = await runGit(ctx, ["status", "--porcelain", "--branch"], path);
        return format(r, "git status");
      } catch (err) {
        return spawnError(err, "git_status");
      }
    },
  };
}

// ───────────────────────────────────────────────────────────────────────
// git_diff
// ───────────────────────────────────────────────────────────────────────

export function createGitDiffTool(allowedPaths: string[]): Tool {
  const manifest: ToolManifest = {
    name: "git_diff",
    description:
      "Show a unified diff. Defaults to unstaged changes; set `staged: true` " +
      "to see what's already in the index. Output is capped at 1 MB by the sandbox.",
    permissions: ["process:spawn", "fs:read"],
    networkAccess: false,
    allowedPaths,
    allowedExecutables: GIT_ALLOWED,
  };
  return {
    manifest,
    parameters: {
      path: PATH_PARAM,
      staged: { type: "boolean", description: "When true, show staged changes (`--cached`).", required: false },
      file: { type: "string", description: "Optional path within the repo to limit the diff to.", required: false },
      max_lines: { type: "number", description: "Cap on the number of diff lines (default 1000).", required: false },
    },
    async execute(args, ctx) {
      const path = repoPath(args, ctx.manifest);
      if (!path) return badArgs("git_diff: no 'path' given and no workspace root configured.");
      const staged = args.staged === true;
      const file = typeof args.file === "string" && args.file.trim() ? args.file : null;
      const maxLines = typeof args.max_lines === "number" ? Math.max(1, Math.floor(args.max_lines)) : 1000;

      const gitArgs = ["diff", "--no-color"];
      if (staged) gitArgs.push("--cached");
      if (file) gitArgs.push("--", file);

      try {
        const r = await runGit(ctx, gitArgs, path);
        const lines = r.stdout.split("\n");
        const truncated = lines.length > maxLines;
        const visible = truncated ? lines.slice(0, maxLines).join("\n") : r.stdout;
        const note = truncated
          ? `\n\n[... ${lines.length - maxLines} more lines truncated; re-run with a tighter max_lines or a specific file]`
          : "";
        return {
          ok: r.exitCode === 0,
          content: `[exit ${r.exitCode}, ${r.durationMs}ms] git diff${staged ? " --cached" : ""}${file ? ` -- ${file}` : ""}\n${visible}${note}`,
          data: { ...r, fullLineCount: lines.length, truncatedByMaxLines: truncated },
        };
      } catch (err) {
        return spawnError(err, "git_diff");
      }
    },
  };
}

// ───────────────────────────────────────────────────────────────────────
// git_log
// ───────────────────────────────────────────────────────────────────────

export function createGitLogTool(allowedPaths: string[]): Tool {
  const manifest: ToolManifest = {
    name: "git_log",
    description:
      "Show the last N commits. Format: `hash | author | date | subject` per line. " +
      "Use `branch` to inspect something other than HEAD, `path_filter` to limit history to a subdir.",
    permissions: ["process:spawn", "fs:read"],
    networkAccess: false,
    allowedPaths,
    allowedExecutables: GIT_ALLOWED,
  };
  return {
    manifest,
    parameters: {
      path: PATH_PARAM,
      max: { type: "number", description: "Number of commits to show (default 20, max 200).", required: false },
      branch: { type: "string", description: "Branch or ref to show (default: HEAD).", required: false },
      path_filter: { type: "string", description: "Optional path within the repo to limit history to.", required: false },
    },
    async execute(args, ctx) {
      const path = repoPath(args, ctx.manifest);
      if (!path) return badArgs("git_log: no 'path' given and no workspace root configured.");
      const max = Math.min(Math.max(typeof args.max === "number" ? Math.floor(args.max) : 20, 1), 200);
      const branch = typeof args.branch === "string" && args.branch.trim() ? args.branch : "HEAD";
      const pathFilter = typeof args.path_filter === "string" && args.path_filter.trim() ? args.path_filter : null;

      const gitArgs = [
        "log",
        `-n${max}`,
        "--no-color",
        "--pretty=format:%h | %an | %ad | %s",
        "--date=short",
        branch,
      ];
      if (pathFilter) gitArgs.push("--", pathFilter);

      try {
        const r = await runGit(ctx, gitArgs, path);
        return format(r, `git log -${max}${branch !== "HEAD" ? ` ${branch}` : ""}`);
      } catch (err) {
        return spawnError(err, "git_log");
      }
    },
  };
}

// ───────────────────────────────────────────────────────────────────────
// git_commit — strict: no push, no force, no amend, no --no-verify bypass
// ───────────────────────────────────────────────────────────────────────

const FORBIDDEN_COMMIT_FLAGS = ["--push", "--force", "--no-verify", "-f", "--amend"];

export function createGitCommitTool(allowedPaths: string[]): Tool {
  const manifest: ToolManifest = {
    name: "git_commit",
    description:
      "Create a commit. Blocks `--push` / `--force` / `--no-verify` / `--amend` by design " +
      "(this tool never touches remotes or rewrites history). Set `add_all: true` to " +
      "stage everything first.",
    permissions: ["process:spawn", "fs:read", "fs:write"],
    networkAccess: false,
    allowedPaths,
    allowedExecutables: GIT_ALLOWED,
  };
  return {
    manifest,
    parameters: {
      path: PATH_PARAM,
      message: { type: "string", description: "Commit message. Multi-line messages supported.", required: true },
      add_all: { type: "boolean", description: "When true, run `git add -A` first (default: only commit already-staged).", required: false },
    },
    async execute(args, ctx) {
      const path = repoPath(args, ctx.manifest);
      const message = args.message;
      if (!path) return badArgs("git_commit: no 'path' given and no workspace root configured.");
      if (typeof message !== "string" || !message.trim()) return badArgs("git_commit requires a non-empty 'message' string.");

      // Defense in depth: refuse if the message itself contains any of the
      // forbidden flags. A model could try to smuggle them via the message.
      const lowered = message.toLowerCase();
      for (const flag of FORBIDDEN_COMMIT_FLAGS) {
        if (lowered.includes(flag)) {
          return {
            ok: false,
            content: `git_commit message contains forbidden flag "${flag}". This tool never pushes, force-pushes, or rewrites history.`,
            error: "forbidden_flag",
          };
        }
      }

      try {
        if (args.add_all === true) {
          const addRes = await runGit(ctx, ["add", "-A"], path);
          if (addRes.exitCode !== 0) {
            return {
              ok: false,
              content: `git add -A failed: ${addRes.stderr || "(no stderr)"}`,
              error: "add_failed",
            };
          }
        }
        // Read the commit message from stdin so multi-line messages work
        // without the agent having to know git's quoting rules.
        const r = await runGit(ctx, ["commit", "-F", "-"], path, 60_000, message);
        return format(r, `git commit -m <stdin, ${message.length} chars>`);
      } catch (err) {
        return spawnError(err, "git_commit");
      }
    },
  };
}

// ───────────────────────────────────────────────────────────────────────
// git_branch — list, create, switch, delete
// ───────────────────────────────────────────────────────────────────────

export function createGitBranchTool(allowedPaths: string[]): Tool {
  const manifest: ToolManifest = {
    name: "git_branch",
    description:
      "List, create, switch, or delete branches. Defaults to listing " +
      "(equivalent to `git branch --list`). Use `action: 'create'` with a " +
      "`name` to create-and-switch, `action: 'switch'` to checkout, " +
      "`action: 'delete'` to remove a fully-merged branch. Refuses to " +
      "delete the currently checked-out branch.",
    permissions: ["process:spawn", "fs:read", "fs:write"],
    networkAccess: false,
    allowedPaths,
    allowedExecutables: GIT_ALLOWED,
  };
  return {
    manifest,
    parameters: {
      path: PATH_PARAM,
      action: {
        type: "string",
        description: "One of: 'list' (default), 'create', 'switch', 'delete'.",
        required: false,
      },
      name: { type: "string", description: "Branch name (required for create/switch/delete).", required: false },
      force: { type: "boolean", description: "When deleting, allow deletion of unmerged branches (`-D` instead of `-d`).", required: false },
    },
    async execute(args, ctx) {
      const path = repoPath(args, ctx.manifest);
      if (!path) return badArgs("git_branch: no 'path' given and no workspace root configured.");
      const action = typeof args.action === "string" && args.action.trim() ? args.action : "list";
      const name = typeof args.name === "string" && args.name.trim() ? args.name : null;
      const force = args.force === true;

      try {
        let gitArgs: string[];
        let hint: string;
        switch (action) {
          case "list":
            gitArgs = ["branch", "-a", "--no-color"];
            hint = "git branch --list (all branches)";
            break;
          case "create":
            if (!name) return badArgs("git_branch action='create' requires 'name'.");
            gitArgs = ["checkout", "-b", name];
            hint = `git checkout -b ${name}`;
            break;
          case "switch":
            if (!name) return badArgs("git_branch action='switch' requires 'name'.");
            gitArgs = ["checkout", name];
            hint = `git checkout ${name}`;
            break;
          case "delete":
            if (!name) return badArgs("git_branch action='delete' requires 'name'.");
            gitArgs = ["branch", force ? "-D" : "-d", name];
            hint = `git branch ${force ? "-D" : "-d"} ${name}`;
            break;
          default:
            return badArgs(`git_branch: unknown action "${action}". Use list|create|switch|delete.`);
        }
        const r = await runGit(ctx, gitArgs, path, 30_000);
        return format(r, hint);
      } catch (err) {
        return spawnError(err, "git_branch");
      }
    },
  };
}
