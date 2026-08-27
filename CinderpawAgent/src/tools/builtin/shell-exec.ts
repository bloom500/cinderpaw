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
 *   - ANY binary may be invoked. There is no name allowlist, because the old
 *     one had the OS shells on it and `sh -c "<anything>"` runs anything — it
 *     blocked direct calls to `ffmpeg` while permitting the same work one
 *     wrapper away. See loadShellWhitelist for the full argument.
 *     `CINDERPAW_SHELL_WHITELIST="git,node,…"` restricts to a named set when that
 *     is genuinely wanted.
 *   - Requested binaries are still resolved through the forced-safe PATH at
 *     call time, so PATH-hijack is closed with or without a list.
 *   - cwd is bound to allowedPaths, unless the operator chose `full_access`.
 *   - stdout/stderr are capped at the sandbox output limit (1 MB default).
 *   - timeoutMs is hard-clamped to the sandbox ceiling.
 *   - The tool is registered by DEFAULT; set CINDERPAW_ENABLE_SHELL_EXEC=false to
 *     disable it entirely (see boot.ts).
 *
 * What actually holds the line, and it is not a list of program names:
 *   1. Owner-only exposure. `PUBLIC_ALLOWED_TOOLS` omits shell_exec, so the
 *      public lead-mode profile cannot reach it; every other connector session
 *      is gated by that connector's inbound allowlist of who may talk at all.
 *      This is the real boundary — if it ever leaks, no binary list saves it.
 *   2. Env scrubbing: the parent env is not inherited, loader vars (LD_, DYLD_,
 *      NODE_, PYTHONPATH) are blocked, PATH is forced from the safe base.
 *   3. `read_only` mode refuses every mutating intent, by classification, at
 *      call time — the mode for a surface where the speaker is not the owner.
 *   4. A best-effort denylist of catastrophic commands (rm -rf /, mkfs, disk
 *      overwrite, fork bomb; override via CINDERPAW_SHELL_DENYLIST). A footgun
 *      guard, NOT a security boundary: encoding or `python -c` walks past it.
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
import { resolve, join, sep } from "node:path";
import { tmpdir, homedir } from "node:os";
import { resolveExecutables } from "../../core/executables.ts";
import { feralHome, readEnv } from "../../config.ts";
import { classifyCommand, recordIntent } from "../../core/command-intent.ts";
import {
  canAskAHuman,
  decideIntent,
  decideOutsideWorkspace,
  permissionMode,
} from "../../core/permission-mode.ts";

/**
 * Which programs may `shell_exec` invoke? By default: any of them.
 *
 * The old default named the OS shells plus a dev toolchain — and the shells
 * were on it, so `["sh","-c","<anything>"]` already ran anything. The list
 * therefore never gated execution. What it did was make `ffmpeg`, `docker`,
 * `rg` and `curl` fail on a direct call while the identical command through
 * `sh -c` succeeded, which teaches the agent to route everything through a
 * shell and teaches the reader that a boundary exists where none does. A gate
 * the intended user steps around by habit is friction wearing a gate's clothes;
 * the honest move is to drop it and be plain about what actually holds.
 *
 * What actually holds, unchanged (see the module docstring): no shell is
 * spawned unless the model asks for one; the parent env is not inherited and
 * loader vars are scrubbed; PATH is forced to the safe base, so bare names
 * still resolve through it and PATH-hijack stays closed; cwd is bound to
 * allowedPaths outside `full_access`; `read_only` mode refuses any mutating
 * intent; the catastrophic denylist runs over the whole joined argv; and no
 * non-owner profile carries this tool (PUBLIC_ALLOWED_TOOLS omits it).
 *
 * `CINDERPAW_SHELL_WHITELIST="git,node,…"` still RESTRICTS to a named set. That is
 * the only reason the knob survives — going the other way needs no knob now.
 */
function loadShellWhitelist(): string[] {
  const env = (readEnv("CINDERPAW_SHELL_WHITELIST") ?? "").trim();
  // The wildcard is passed through literally (NOT through resolveExecutables,
  // which would try to resolve "*" as a program). The ProcessSandbox still
  // resolves each requested binary through the safe PATH at call time.
  if (env === "" || env === "*") return ["*"];
  const named = env.split(",").map((s) => s.trim()).filter(Boolean);
  // A knob set to "," or " " states no restriction. Returning [] here would
  // instead disable process:spawn outright (tool-permissions rejects an empty
  // allowedExecutables), turning a typo into a silently dead tool.
  return named.length > 0 ? resolveExecutables(named) : ["*"];
}

const SAFE_BINARIES = loadShellWhitelist();
/** No named restriction — every binary is callable directly. */
const ANY_BINARY = SAFE_BINARIES.includes("*");

/**
 * Best-effort denylist of catastrophic, irreversible commands. This is a
 * guard rail against the agent footgunning itself, NOT a security boundary:
 * a determined caller trivially evades it (encoding, alternate paths,
 * `python -c "os.system(...)"`). Kept deliberately TIGHT so it never blocks
 * ordinary work (`rm -rf node_modules` is fine; `rm -rf /` is not). The scan
 * runs on the whole joined argv, so shell payloads (`sh -c "rm -rf /"`) are
 * covered too. Override the set with CINDERPAW_SHELL_DENYLIST (comma-separated
 * regexes); set it empty to disable entirely.
 */
function loadDenylist(): RegExp[] {
  const env = readEnv("CINDERPAW_SHELL_DENYLIST");
  if (env !== undefined) {
    return env.split(",").map((s) => s.trim()).filter(Boolean).map((s) => new RegExp(s, "i"));
  }
  return [
    /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(-[a-z]*\s+)*(\/|~|\$HOME|\.)\s*$/i, // rm -rf / | ~ | $HOME | .
    /\bmkfs(\.\w+)?\b/i,                       // filesystem format
    /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|disk)/i, // raw disk overwrite
    /[:%]\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb :(){ :|:& };:
    />\s*\/dev\/(sd|nvme|hd|disk)/i,           // redirect over a raw disk
    /\bchmod\s+-R\s+0*\s+\//i,                 // chmod -R 000 /
    /\b(shutdown|reboot|halt|poweroff)\b/i,    // host power state
  ];
}

const DENYLIST = loadDenylist();

/** True if the joined command matches a catastrophic pattern. */
export function isDestructive(commandLine: string): boolean {
  return DENYLIST.some((re) => re.test(commandLine));
}

/**
 * Verbs that remove or overwrite what they are pointed at. Deliberately only
 * the ones whose whole purpose is destruction — `git reset --hard` and friends
 * are missing because they can only act inside a repository, which is inside a
 * workspace root, which the safety point already snapshots and can undo.
 */
const DESTRUCTIVE_VERBS =
  /(^|[\s;&|(])(rm|rmdir|rd|del|erase|unlink|shred|srm|truncate|mkfs|format|rimraf|remove-item|ri|clear-content)([\s]|$)/i;

/**
 * Absolute paths in any spelling a shell payload might carry.
 *
 * The POSIX branch deliberately will not match `/c`, `/q`, `/s` — those are
 * Windows command switches (`cmd /c del …`), and treating a switch as the
 * target would make the guard fire on the wrong token and report nonsense.
 * A real path either has a first segment of three characters or a second
 * slash; a bare `/` is the catastrophic case the denylist above already owns.
 */
const ABSOLUTE_PATH =
  /(?:[A-Za-z]:[\\/][^\s"';|&)]*|~[\\/][^\s"';|&)]*|(?<![\w:])\/(?:[^\s"';|&)\\/]{3,}[^\s"';|&)]*|[^\s"';|&)]*\/[^\s"';|&)]*))/g;

/** Case-insensitive path comparison on Windows, exact everywhere else. */
function samePathSpace(p: string): string {
  const normal = resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normal.toLowerCase() : normal;
}

function isInside(path: string, root: string): boolean {
  const p = samePathSpace(path);
  const r = samePathSpace(root);
  return p === r || p.startsWith(r + sep) || p.startsWith(r + "/");
}

/**
 * The path a destructive command would hit outside every workspace root, or
 * null when there is nothing to object to.
 *
 * This is a footgun guard for a cooperating agent that made a mistake, exactly
 * like the catastrophic denylist above — NOT a security boundary. Anything
 * that wants to evade it can (`python -c`, base64, a path assembled at
 * runtime), and that is a different threat model needing OS-level isolation.
 *
 * Two deliberate refusals to overreach:
 *   - a command with no destructive verb is never blocked, however far it reads
 *   - with no roots configured, nothing is blocked: unknown is not unsafe, and
 *     a headless install that never set a root must not become unusable
 */
export function destructiveOutsideRoots(argv: string[], roots: string[]): string | null {
  if (roots.length === 0) return null;
  const line = argv.join(" ");
  if (!DESTRUCTIVE_VERBS.test(line)) return null;

  // Scratch space the agent is expected to churn through. Its own temp files
  // are not the user's work, and refusing to clean them up teaches the agent
  // to leave litter.
  const allowed = [...roots, tmpdir(), feralHome()];
  for (const match of line.match(ABSOLUTE_PATH) ?? []) {
    // "/" and "C:\" alone are the catastrophic case the denylist already owns;
    // leaving them here too costs nothing and closes the ordering question.
    const target = match.startsWith("~")
      ? join(homedir(), match.slice(1))
      : match;
    if (!allowed.some((root) => isInside(target, root))) return match;
  }
  return null;
}

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
  if (ANY_BINARY) return true; // the denylist and the mode are the gates
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
      "timeout (default 2min, max 5min unless the host raised it). ALWAYS pass an explicit " +
      "`timeout_ms` for a build, install, or test run — a killed process is reported as a " +
      "failure and you cannot tell it apart from a real one. The git_* / run_tests / format_code tools are " +
      "convenient shortcuts but this tool can do anything a terminal can.",
    permissions: ["process:spawn", "fs:read"],
    networkAccess: false,
    allowedPaths,
    allowedExecutables: SAFE_BINARIES,
    // Running any BINARY and running in any DIRECTORY are two different
    // permissions, and they used to ride one flag: taking the binary list off
    // silently unbound cwd from the workspace as well. Which binary may run is
    // now the default; where it may run stays the operator's explicit call,
    // named as such. `CINDERPAW_SHELL_WHITELIST="*"` still resolves to full_access
    // (see permissionMode), so an existing YOLO install is unchanged.
    allowAnyCwd: permissionMode() === "full_access",
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
        description: "Timeout in milliseconds (default 120000 = 2min; max 300000 = 5min unless the host raised it via CINDERPAW_SHELL_MAX_TIMEOUT_MS). Values above the max are clamped, not rejected. For a build or install, pass a larger value.",
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

      // Denylist gate FIRST — best-effort catastrophe guard, active in every
      // mode (including YOLO). Scans the whole joined command so a shell
      // payload (sh -c "rm -rf /") is caught, not just argv[0].
      if (isDestructive(argv.join(" "))) {
        return {
          ok: false,
          content:
            "shell_exec: refused — command matches the catastrophic-command " +
            "denylist (e.g. rm -rf /, mkfs, disk overwrite, fork bomb). " +
            "Override with CINDERPAW_SHELL_DENYLIST if this is intentional.",
          error: "destructive_command",
        };
      }

      // What this command is FOR, decided once and used for both the mode gate
      // and the report. A shell payload is classified by what it runs, not by
      // the fact that it is a shell.
      const mode = permissionMode();
      const intent = classifyCommand(argv);
      recordIntent(ctx.sessionId, intent);

      const byIntent = decideIntent(intent, mode);
      if (byIntent.kind === "block") {
        return { ok: false, content: `shell_exec: ${byIntent.reason}`, error: "permission_mode" };
      }

      // Blast-radius gate: destruction aimed outside every workspace root. The
      // denylist above covers what wrecks the machine; this covers what wrecks
      // the person — their Documents folder, another project, a sibling repo.
      // Inside the workspace the same command is allowed, because the safety
      // point snapshots it and can put it back.
      const outside = destructiveOutsideRoots(argv, allowedPaths);
      if (outside) {
        const call = decideOutsideWorkspace(outside, mode);
        if (call.kind === "warn") {
          // A human decides. With nobody there this refuses rather than
          // auto-approving — an agent that can approve its own irreversible
          // act outside the workspace is not gated at all.
          if (!canAskAHuman(Boolean(ctx.askUser))) {
            return {
              ok: false,
              content:
                `shell_exec: refused — ${call.detail}. Nobody is available to approve it ` +
                `(walk-away mode). Work inside the workspace (${allowedPaths.join(", ")}), ` +
                `or leave this for the user.`,
              error: "destructive_outside_workspace",
            };
          }
          const [answer] = await ctx.askUser!.ask(
            [{
              question: call.question,
              header: "Outside WS",
              multiSelect: false,
              // Irreversible and outside the snapshot: never auto-answered.
              forceEscalate: true,
              options: [
                { label: "No, skip it", description: `Refuse: ${call.detail}.` },
                { label: "Yes, delete it", description: "Allow this one command to run." },
              ],
            }],
            ctx.sessionId,
          );
          const approved = answer?.selected?.[0]?.toLowerCase().startsWith("yes") ?? false;
          if (!approved) {
            return {
              ok: false,
              content: `shell_exec: the user declined — ${call.detail}.`,
              error: "destructive_outside_workspace",
            };
          }
        }
      }

      // Whitelist gate BEFORE the sandbox call so it is testable without a
      // process sandbox and so the model gets a clear, recoverable error.
      if (!isWhitelisted(binary)) {
        return {
          ok: false,
          content:
            "shell_exec: binary \"" + binary + "\" is not in the safe-binary whitelist. " +
            "Set CINDERPAW_SHELL_WHITELIST in your environment to allow it, " +
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
