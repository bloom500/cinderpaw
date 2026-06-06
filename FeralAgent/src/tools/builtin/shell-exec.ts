/**
 * shell_exec — run a shell command inside the sandbox.
 *
 * Security model:
 *   - The command is passed as a single STRING, not an argv array. This is
 *     intentional: argv arrays are safer (no shell metacharacter parsing)
 *     but require the model to construct the right quoting. Since the
 *     manifest is the security gate, we keep this simple and the user can
 *     write `node -e "console.log(1)"` directly.
 *   - cwd is bound to allowedPaths (via the ProcessSandbox).
 *   - stdout/stderr are capped at the sandbox output limit (1 MB default).
 *   - timeoutMs is hard-clamped to the sandbox ceiling.
 *   - The sandbox refuses executables that are not on the tool's
 *     allowedExecutables list; for `shell_exec` we use the platform's
 *     default shell (`sh -c` / `cmd /c`).
 *
 * This is the "advanced" / "escape hatch" tool — most agent work should
 * go through the narrower `run_tests`, `format_code`, `git_*` tools
 * below. `shell_exec` is registered conditionally (env-controlled) so
 * teams who don't want a generic shell can leave it off.
 */

import type { Tool, ToolManifest } from "../../types.ts";
import { resolveExecutables } from "../../core/executables.ts";

const isWin = process.platform === "win32";

/**
 * Resolve the platform shells to absolute paths at module load. The
 * manifest carries these absolute paths so the ProcessSandbox matches by
 * path (Case B) rather than by basename+PATH-walk (Case C) — closes the
 * PATH-hijack window for `shell_exec`.
 */
const SHELL_EXECUTABLES = resolveExecutables(isWin ? ["cmd", "sh"] : ["sh"]);

/**
 * Build the manifest. The allowed executable is the platform's default
 * shell: `sh` on POSIX (which every Unix-like system has, including
 * macOS), `cmd` on Windows. The model's responsibility is to craft a
 * safe `command` string — the sandbox will not parse it.
 */
export function createShellExecTool(allowedPaths: string[]): Tool {
  const manifest: ToolManifest = {
    name: "shell_exec",
    description:
      "Run a shell command on the host. The command is passed to the " +
      "platform's default shell (`sh -c` on POSIX, `cmd /c` on Windows). " +
      "Output is capped at 1 MB; processes are hard-killed after the " +
      "timeout. The cwd must be inside the tool's allowed paths. Prefer " +
      "the narrower git_* / run_tests / format_code tools over this.",
    permissions: ["process:spawn", "fs:read"],
    networkAccess: false,
    allowedPaths,
    allowedExecutables: SHELL_EXECUTABLES,
  };

  return {
    manifest,
    parameters: {
      command: {
        type: "string",
        description:
          "The shell command to run. Passed verbatim to the platform's " +
          "default shell, so be careful with quoting and untrusted input.",
        required: true,
      },
      cwd: {
        type: "string",
        description: "Working directory. Must be inside the tool's allowed paths.",
        required: false,
      },
      timeout_ms: {
        type: "number",
        description: "Timeout in milliseconds (default 30s, max 5min).",
        required: false,
      },
      env: {
        type: "object",
        description: "Optional extra environment variables (PATH is never overridable).",
        required: false,
      },
    },
    async execute(args, ctx) {
      if (!ctx.process) {
        return { ok: false, content: "shell_exec: process sandbox unavailable", error: "no_sandbox" };
      }
      const command = args.command;
      if (typeof command !== "string" || !command.trim()) {
        return { ok: false, content: "shell_exec requires a non-empty 'command' string.", error: "bad_args" };
      }
      const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : undefined;
      const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;
      const env = args.env && typeof args.env === "object" && !Array.isArray(args.env)
        ? (args.env as Record<string, string>)
        : undefined;

      try {
        const result = await ctx.process.run(ctx.manifest, ctx.sessionId, {
          executable: isWin ? "cmd" : "sh",
          args: isWin ? ["/c", command] : ["-c", command],
          cwd,
          env,
          timeoutMs,
        });

        // Format the result as a code block so the agent can quote parts
        // of it verbatim in subsequent turns. Include the exit code and
        // duration so the agent can self-diagnose.
        const header = `$ ${command}\n` +
          (cwd ? `  (cwd: ${cwd})\n` : "") +
          `[exit ${result.exitCode}` +
          (result.timedOut ? ", timed out" : "") +
          (result.outputTruncated ? ", output truncated" : "") +
          `, ${result.durationMs}ms]`;
        const out = result.stdout ? `\n${result.stdout}` : "";
        const err = result.stderr ? `\n[stderr]\n${result.stderr}` : "";
        const ok = result.exitCode === 0 && !result.timedOut;

        return {
          ok,
          content: `${header}${out}${err}`,
          data: {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
            outputTruncated: result.outputTruncated,
          },
        };
      } catch (err) {
        return {
          ok: false,
          content: `shell_exec failed: ${String((err as Error).message ?? err)}`,
          error: "spawn_error",
        };
      }
    },
  };
}
