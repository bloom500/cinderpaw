/**
 * shell_exec — run a program inside the sandbox.
 *
 * Security model (V2 — argv-only):
 *   - There is NO shell. The command is executed as an argv array
 *     (`[binary, ...args]`) handed straight to `ProcessSandbox.run`, which
 *     spawns the resolved binary directly. No `sh -c` / `cmd /c` wrapper is
 *     ever used, so shell metacharacters (`;`, `&&`, `|`, backticks, `$()`,
 *     redirects, globs) are NOT interpreted — they become literal arguments
 *     to the target program. This closes the whitelist-bypass where a
 *     whitelisted first binary (e.g. `node`) let an attacker chain arbitrary
 *     commands (`node && rm -rf x`): the whole string used to be passed to a
 *     real shell, so only the first token was ever checked.
 *   - The binary (argv[0]) must be on the env-controlled whitelist, resolved
 *     to an absolute path at module load so PATH-hijack is impossible.
 *   - cwd is bound to allowedPaths (via the ProcessSandbox).
 *   - stdout/stderr are capped at the sandbox output limit (1 MB default).
 *   - timeoutMs is hard-clamped to the sandbox ceiling.
 *   - The tool itself is registered ONLY when FERAL_ENABLE_SHELL_EXEC=true
 *     (see `index.ts`) — a generic program runner is opt-in, not default-on.
 *
 * Input shapes accepted (in priority order):
 *   1. `argv: string[]`  — the preferred, unambiguous form. The model passes
 *      `["node", "-e", "console.log(1)"]`. No parsing, no quoting pitfalls.
 *   2. `command: string` — tokenized into an argv array with a quote-aware
 *      splitter (single/double quotes honored). Because no shell runs, an
 *      imperfect split is at worst a correctness issue for that one call —
 *      never a security one.
 *
 * This is the "advanced" / "escape hatch" tool — most agent work should go
 * through the narrower `run_tests`, `format_code`, `git_*` tools.
 */

import type { Tool, ToolManifest } from "../../types.ts";
import { resolveExecutables } from "../../core/executables.ts";

/**
 * Env-controlled whitelist of programs `shell_exec` may invoke.
 *
 * Only real, spawnable binaries belong here — shell builtins (`cd`, `set`,
 * `export`, `if`, `for`, …) are intentionally gone: with no shell there is
 * nothing to interpret them, and listing them would be misleading. Bare
 * names are resolved to absolute paths at module load so the ProcessSandbox
 * matches by path and PATH-hijack is impossible.
 *
 * Default allowlist: the OS shells PLUS the common dev toolchain. The shells
 * (`cmd`, `powershell`, `pwsh`, `bash`, `sh`) are what give the agent COMPLETE
 * shell access: invoked as `["sh","-c","<cmdline>"]` / `["cmd","/c","<cmdline>"]`
 * the shell interprets the full command line (pipes, &&, redirects, globbing)
 * and can launch ANY program — so whitelisting the shells is, by design,
 * unrestricted execution. The narrower dev binaries are kept so the agent can
 * also call them directly without spinning up a shell.
 *
 * Override the whole set with FERAL_SHELL_WHITELIST="git,node,…" to RESTRICT
 * the agent (e.g. drop the shells to go back to a locked-down toolchain).
 */
function loadShellWhitelist(): string[] {
  const env = process.env.FERAL_SHELL_WHITELIST;
  const raw = env && env.trim().length > 0
    ? env.split(",").map((s) => s.trim()).filter(Boolean)
    : ["cmd", "powershell", "pwsh", "bash", "sh", // full shell access
       "git", "node", "python", "python3", "cargo", "npm", "npx",
       "pip", "pip3", "make", "go", "bun", "deno"];
  return resolveExecutables(raw);
}

const SAFE_BINARIES = loadShellWhitelist();

/**
 * Reduce a binary name or path to its comparison "stem": lowercased basename
 * with any Windows executable extension stripped. So `C:\bin\git.exe`,
 * `git.EXE`, and `git` all reduce to `git`. This makes the whitelist check
 * agnostic to how the binary was spelled (bare vs absolute, with vs without
 * extension) — resolveExecutables() turns `git` into an absolute `git.exe`
 * on Windows, which a naive basename match would miss.
 */
export function binaryStem(nameOrPath: string): string {
  const base = (nameOrPath.split(/[\\/]/).pop() ?? nameOrPath).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|com)$/i, "");
}

const SAFE_BINARY_STEMS = new Set(SAFE_BINARIES.map(binaryStem));

/**
 * Split a command string into an argv array, honoring single and double
 * quotes. This is a TOKENIZER, not a shell: it performs no variable
 * expansion, no command substitution, no operator handling. A `;` or `&&`
 * in the input becomes an ordinary token. Used only for the legacy
 * `command: string` input shape; `argv` callers skip it entirely.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        current += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      hasToken = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += c;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/** Does this binary name/path appear on the whitelist? Compared by stem, so
 *  `git`, `git.exe`, and an absolute path to git all match the same entry.
 *  This is a fast, friendly pre-check — the ProcessSandbox still enforces the
 *  exact allowlisted path as the real gate (PATH-hijack defense). */
function isWhitelisted(binary: string): boolean {
  return SAFE_BINARY_STEMS.has(binaryStem(binary));
}

/**
 * Build the manifest. `allowedExecutables` is the resolved whitelist itself,
 * so the ProcessSandbox enforces the exact same set by absolute path. The
 * spawn target is the real program (git, node, …), never a shell.
 */
export function createShellExecTool(allowedPaths: string[]): Tool {
  const manifest: ToolManifest = {
    name: "shell_exec",
    description:
      "Run a program on the host. Provide `argv` as an array: [\"git\", \"status\"]. " +
      "argv[0] is spawned DIRECTLY (no shell), so pipes/&&/;/redirects/globbing in " +
      "argv are literal arguments, not shell operators. " +
      "FULL SHELL ACCESS: to use pipes, redirects, chaining or globbing — or to run " +
      "ANY program — invoke a shell explicitly: on Windows argv=[\"cmd\",\"/c\",\"dir | findstr foo\"] " +
      "or [\"powershell\",\"-Command\",\"...\"]; elsewhere argv=[\"sh\",\"-c\",\"ls | grep foo\"]. " +
      "The shell then interprets the whole command line. Set `cwd` to run inside a " +
      "specific directory. Output is capped at 1 MB; processes are hard-killed after the " +
      "timeout (default 30s, max 5min). The git_* / run_tests / format_code tools are " +
      "convenient shortcuts but this tool can do anything a terminal can.",
    permissions: ["process:spawn", "fs:read"],
    networkAccess: false,
    allowedPaths,
    allowedExecutables: SAFE_BINARIES,
  };

  return {
    manifest,
    parameters: {
      argv: {
        type: "array",
        description:
          "The program and its arguments as an array, e.g. " +
          "[\"node\", \"-e\", \"console.log(1)\"]. The first element is the " +
          "binary (must be whitelisted); the rest are passed verbatim — no " +
          "shell interpretation. Preferred over `command`.",
        required: false,
      },
      command: {
        type: "string",
        description:
          "Legacy: a command line that is tokenized into argv (quotes " +
          "honored). No shell runs, so metacharacters are literal. Prefer `argv`.",
        required: false,
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
      // Resolve argv from either input shape. `argv` wins when both are given.
      let argv: string[];
      if (Array.isArray(args.argv)) {
        argv = args.argv.filter((x): x is string => typeof x === "string");
      } else if (typeof args.command === "string" && args.command.trim()) {
        argv = tokenizeCommand(args.command.trim());
      } else {
        return {
          ok: false,
          content: "shell_exec requires `argv` (array) or `command` (string).",
          error: "bad_args",
        };
      }

      if (argv.length === 0 || !argv[0]?.trim()) {
        return { ok: false, content: "shell_exec: empty command.", error: "bad_args" };
      }

      const binary = argv[0]!;
      const binaryArgs = argv.slice(1);

      // Whitelist gate BEFORE the sandbox call so it is testable without a
      // process sandbox and so the model gets a clear, recoverable error.
      if (!isWhitelisted(binary)) {
        return {
          ok: false,
          content:
            "shell_exec: binary \"" + binary + "\" is not in the safe-binary whitelist. " +
            "Set FERAL_SHELL_WHITELIST in your environment to allow it, " +
            "or use a more specific tool (git_*, code_quality, etc).",
          error: "binary_not_whitelisted",
        };
      }
      if (!ctx.process) {
        return { ok: false, content: "shell_exec: process sandbox unavailable", error: "no_sandbox" };
      }

      const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : undefined;
      const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : undefined;
      const env = args.env && typeof args.env === "object" && !Array.isArray(args.env)
        ? (args.env as Record<string, string>)
        : undefined;

      try {
        // No shell: spawn the binary directly with its argv. The sandbox
        // re-validates `binary` against allowedExecutables (absolute-path
        // match) as defense in depth.
        const result = await ctx.process.run(ctx.manifest, ctx.sessionId, {
          executable: binary,
          args: binaryArgs,
          cwd,
          env,
          timeoutMs,
        });

        const printable = [binary, ...binaryArgs].join(" ");
        const header = `$ ${printable}\n` +
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
