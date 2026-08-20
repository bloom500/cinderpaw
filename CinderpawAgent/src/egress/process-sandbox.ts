/**
 * Process sandbox — the single controlled point for every external process.
 *
 * Non-negotiable constraint: no tool may spawn a process without going through
 * `ProcessSandbox.run`. The sandbox enforces, for every spawn:
 *   - the tool declared `process:spawn` in its manifest
 *   - the executable is in the tool's `allowedExecutables` allowlist
 *     (matched by absolute path or by name resolved against a safe PATH)
 *   - the cwd, when supplied, is contained in the tool's `allowedPaths`
 *   - the process is started with a minimal safe environment
 *     (parent env is NEVER inherited wholesale)
 *   - the process is hard-killed after `timeoutMs`
 *   - stdout / stderr are capped at `maxOutputBytes` (default 1 MB)
 * Every attempt — allowed or blocked — is written to the audit log.
 *
 * The class is constructed once in `index.ts` and threaded into every
 * `ToolContext.process`. Tools that do not declare `process:spawn` simply
 * receive `undefined` for that field.
 */

import { resolve, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import type {
  AuditLogger,
  ProcessRunOptions,
  ProcessRunResult,
  ProcessSandbox,
  ToolManifest,
} from "../types.ts";
import { hasPermission, resolveAllowedPath } from "./tool-permissions.ts";
import { cfgInt, cfgList } from "../config.ts";

export interface ProcessSandboxConfig {
  /** Default per-process timeout in ms when the caller does not specify one. */
  defaultTimeoutMs: number;
  /** Hard ceiling on `timeoutMs` regardless of caller request. */
  maxTimeoutMs: number;
  /** Per-stream output cap in bytes. */
  maxOutputBytes: number;
  /**
   * Minimal environment passed to every child. The parent process env is
   * never inherited wholesale — only the entries listed here (plus any
   * `env` overrides the caller passes through the safe filter).
   */
  safeBaseEnv: Record<string, string>;
}

const DEFAULT_CONFIG: ProcessSandboxConfig = {
  // 2 min default (was 30s — too tight for real builds/installs); callers can
  // still pass a per-call timeout_ms up to maxTimeoutMs.
  defaultTimeoutMs: 120_000,
  // ponytail: calibration knob. 5 min covers `bun install` and most test runs,
  // but a cold `cargo build` on a real project routinely exceeds it and the
  // agent then sees a killed process it cannot distinguish from a failure.
  // Raise with FERAL_SHELL_MAX_TIMEOUT_MS on machines that need it.
  maxTimeoutMs: readMaxTimeoutMs(),
  maxOutputBytes: 1_048_576, // 1 MB
    safeBaseEnv: {
      PATH: safePath(),
      HOME: process.env.HOME ?? (process.env.USERPROFILE ?? ""),
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    },
};

/**
 * PATH for every child process.
 *
 * `process.env.PATH` on its own is whatever happened to launch the gateway, and
 * a process started from a terminal, from Explorer and from a service login all
 * see different ones. That is the whole story behind `bash` failing here while
 * the identical command worked in a terminal two seconds later — no permission,
 * no allowlist, no setting changed between them, and the error said permission.
 *
 * Cinderpaw is meant to be usable by someone who has never heard of PATH, so
 * "install Git and then edit your environment variables" is not an answer. The
 * well-known install locations are appended when they exist on disk.
 *
 * APPENDED, never prepended: whichever `node` or `python` the user's own PATH
 * chooses keeps winning. This only adds fallbacks for tools that were otherwise
 * invisible, so it cannot change which binary an already-working call resolves
 * to.
 *
 * ponytail: a fixed list, not a filesystem crawl or a registry walk. Add a
 * directory when a real install turns up missing, or point
 * FERAL_SHELL_PATH_EXTRA at it — that knob is the upgrade path, and it exists
 * because no fixed list survives contact with every machine.
 */
function safePath(): string {
  const base = process.env.PATH ?? "";
  const win = process.platform === "win32";
  const sep = win ? ";" : ":";
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const appData = process.env.APPDATA ?? `${home}\\AppData\\Roaming`;
  const wellKnown = win
    ? [
        `${programFiles}\\Git\\bin`, // bash, sh
        `${programFiles}\\Git\\usr\\bin`, // the GNU userland that ships with it
        `${programFiles}\\nodejs`,
        `${appData}\\npm`, // npm -g shims: npx.cmd lives here
      ]
    : [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        `${home}/.local/bin`,
        `${home}/.bun/bin`,
        `${home}/.cargo/bin`,
      ];
  const known = new Set(
    base.split(sep).filter(Boolean).map((d) => (win ? d.toLowerCase() : d).replace(/[\\/]+$/, "")),
  );
  const add = [...wellKnown, ...cfgList("FERAL_SHELL_PATH_EXTRA")]
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
    .filter((d) => !known.has((win ? d.toLowerCase() : d).replace(/[\\/]+$/, "")))
    // Absent directories are left out rather than added blind: a PATH full of
    // paths that do not exist makes every miss slower and every log noisier.
    .filter((d) => existsSync(d));
  return add.length > 0 ? [base, ...add].filter(Boolean).join(sep) : base;
}

/**
 * Ceiling on any caller-requested `timeout_ms`. Read once at module load;
 * clamped to [60s, 60min] so a typo can neither make every build fail instantly
 * nor let a wedged process hold a tool slot for the life of the sidecar.
 */
function readMaxTimeoutMs(): number {
  const raw = cfgInt("FERAL_SHELL_MAX_TIMEOUT_MS");
  if (!Number.isFinite(raw) || raw <= 0) return 300_000;
  return Math.min(3_600_000, Math.max(60_000, raw));
}

/**
 * Variable names that may not be set or overridden by the caller. Anything
 * starting with one of these prefixes could load attacker-controlled code
 * into the child process.
 */
const BLOCKED_ENV_PREFIXES = ["LD_", "DYLD_", "NODE_", "PYTHONPATH"];

/** Variable names that may not be overridden even by exact match. */
const BLOCKED_ENV_EXACT = new Set([
  "PATH", // PATH is set from safeBaseEnv and never overridden by the caller
]);

export class RealProcessSandbox implements ProcessSandbox {
  readonly #audit: AuditLogger;
  readonly #config: ProcessSandboxConfig;

  constructor(audit: AuditLogger, config: Partial<ProcessSandboxConfig> = {}) {
    this.#audit = audit;
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  async run(
    manifest: ToolManifest,
    sessionId: string,
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    const start = Date.now();

    const block = (reason: string): never => {
      this.#audit({
        timestamp: Date.now(),
        sessionId,
        actionType: "blocked",
        toolName: manifest.name,
        argsJson: JSON.stringify({ executable: options.executable, args: options.args }),
        result: "blocked",
        blockedReason: reason,
        durationMs: Date.now() - start,
      });
      throw new Error(reason); // bubble to the registry which converts it
    };
    // `block` is `never`, but TypeScript's flow analysis sometimes needs
    // an explicit hint when the throw is inside a closure. The `void block`
    // calls below turn the narrowing on for the rest of the function.
    void block;

    // 1. Permission gate.
    if (!hasPermission(manifest, "process:spawn")) {
      block(`tool "${manifest.name}" has no process:spawn permission`);
    }

    // 2. Executable allowlist — resolve the requested executable to an
    //    absolute path, then ensure the manifest explicitly lists it.
    const resolved = this.#resolveExecutable(manifest, options.executable);
    if (resolved === null) {
      block(this.#refusalReason(manifest, options.executable));
    }
    // After `block` (which is `never`), `resolved` is provably `string`.
    // The explicit non-null assertion silences TS in case the narrowing
    // doesn't propagate through the closure.
    const resolvedPath: string = resolved as string;

    // 3. Cwd containment (only if supplied).
    let safeCwd: string | undefined;
    if (options.cwd) {
      if (!isAbsolute(options.cwd)) {
        block(`cwd must be an absolute path, got "${options.cwd}"`);
      }
      // YOLO / full-host mode: any absolute cwd is allowed. The executable
      // resolution + env scrub below are still enforced; only the cwd bound
      // to allowedPaths is lifted.
      if (manifest.allowAnyCwd) {
        safeCwd = resolve(options.cwd);
      } else
      try {
        // Throws PermissionDeniedError if cwd escapes every allowed root.
        // We need at least one fs:* permission for the tool to have any
        // allowedPaths to bind to.
        const hasFs =
          hasPermission(manifest, "fs:read") ||
          hasPermission(manifest, "fs:write");
        if (!hasFs || !manifest.allowedPaths || manifest.allowedPaths.length === 0) {
          block(
            `tool "${manifest.name}" cannot specify a cwd without fs:* permission and allowedPaths`,
          );
        }
        // Use "fs:read" as the permission to validate against — the sandbox
        // is about the *path* being read/exec'd, not about reading file content.
        safeCwd = resolveAllowedPath(manifest, "fs:read", options.cwd);
      } catch (err) {
        block(
          `cwd "${options.cwd}" is outside allowedPaths for "${manifest.name}": ${String(err)}`,
        );
      }
    }

    // 4. Build a safe env. Start from the safe base, then merge caller
    //    overrides (filtered).
    const childEnv: Record<string, string> = { ...this.#config.safeBaseEnv };
    if (options.env) {
      for (const [k, v] of Object.entries(options.env)) {
        if (BLOCKED_ENV_EXACT.has(k)) continue;
        if (BLOCKED_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
        childEnv[k] = v;
      }
    }

    // 5. Clamp timeout to the configured ceiling.
    const timeoutMs = Math.min(
      Math.max(options.timeoutMs ?? this.#config.defaultTimeoutMs, 1_000),
      this.#config.maxTimeoutMs,
    );

    // 6. Spawn. Use Bun.spawn for cross-platform async child processes.
    const proc = Bun.spawn({
      cmd: [resolvedPath, ...(options.args ?? [])],
      cwd: safeCwd,
      env: childEnv,
      stdin: options.stdin != null ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Deliver the stdin payload and close the pipe — a child reading stdin
    // to EOF (e.g. `git commit -F -`) blocks forever otherwise.
    if (options.stdin != null && proc.stdin) {
      proc.stdin.write(options.stdin);
      await proc.stdin.end();
    }

    // 7. Capture stdout/stderr with an output cap. We start a reader for
    //    each stream and abort the proc when the cap is reached so a
    //    runaway child cannot fill the host's memory.
    const cap = this.#config.maxOutputBytes;
    const { stdout, stderr, truncated } = await this.#readWithCap(proc, cap, timeoutMs);

    const durationMs = Date.now() - start;
    const exitCode = await proc.exited;
    const timedOut = stdout.timedOut || stderr.timedOut;
    const finalExit = timedOut ? -2 : exitCode;

    const result: ProcessRunResult = {
      exitCode: finalExit,
      stdout: stdout.text,
      stderr: stderr.text,
      durationMs,
      timedOut,
      outputTruncated: truncated,
    };

    this.#audit({
      timestamp: Date.now(),
      sessionId,
      actionType: "tool_call",
      toolName: manifest.name,
      argsJson: JSON.stringify({
        executable: options.executable,
        args: options.args,
        cwd: safeCwd,
        timeoutMs,
      }),
      result: timedOut || finalExit !== 0 ? "error" : "success",
      blockedReason: timedOut
        ? `process killed after ${timeoutMs}ms`
        : finalExit !== 0
          ? `exit code ${finalExit}`
          : undefined,
      durationMs,
    });

    if (options.throwOnNonZero && finalExit !== 0) {
      const e = new Error(
        `process "${options.executable}" exited with code ${finalExit}` +
          (result.stderr ? `: ${result.stderr.slice(0, 500)}` : ""),
      );
      (e as Error & { exitCode?: number; result?: ProcessRunResult }).exitCode = finalExit;
      (e as Error & { exitCode?: number; result?: ProcessRunResult }).result = result;
      throw e;
    }

    return result;
  }

  /**
   * Why the spawn was refused, in words that match the actual cause.
   *
   * One message used to cover both causes — "is not in allowedExecutables" —
   * and it was the wrong one most of the time. `bash`, `sh` and `python3` were
   * all ON the default allowlist and still failed with it, because the list
   * held bare names that no longer resolved on the sidecar's PATH, and a PATH
   * miss and a permission refusal came out of the same `null`.
   *
   * The cost was not confusion, it was a wrong conclusion acted upon: the agent
   * believed the message, told the user it lacked permission to run the
   * command, and offered to work around a boundary that was never the problem.
   * That is how "it cannot install a skill because of permissions" was
   * diagnosed — and the allowlist got taken off for a fault it never had.
   *
   * An error message is the only thing the model has to reason from. This one
   * now says which of the two happened, and says outright when it is not about
   * permission at all.
   */
  #refusalReason(manifest: ToolManifest, requested: string): string {
    const list = manifest.allowedExecutables ?? [];
    if (isAbsolute(requested)) {
      return existsSync(resolve(requested))
        ? `executable "${requested}" is not in allowedExecutables for "${manifest.name}"`
        : `executable "${requested}" does not exist. This is not a permission problem.`;
    }
    const parts = requested.split(/[\\/]/);
    const bare = parts[parts.length - 1] ?? requested;
    const pathEnv = this.#config.safeBaseEnv.PATH ?? "";
    if (which(bare, pathEnv) === null) {
      const dirs = pathEnv.split(process.platform === "win32" ? ";" : ":").filter(Boolean).length;
      return (
        `executable "${bare}" was not found on PATH (${dirs} directories searched). ` +
        `This is NOT a permission problem and there is nothing to work around: ` +
        `install it, or call it by absolute path. Note the agent's PATH is the one ` +
        `the gateway process was started with, which may be shorter than a terminal's.`
      );
    }
    // Findable, so the list is genuinely what stopped it. Name the alternatives:
    // "not allowed" without "here is what is" makes the model guess.
    const names = list.map((e) => e.split(/[\\/]/).pop() ?? e).join(", ");
    return (
      `executable "${bare}" is not in allowedExecutables for "${manifest.name}" ` +
      `(allowed: ${names || "none"})`
    );
  }

  /**
   * Resolve a requested executable against the tool's `allowedExecutables`
   * list. Returns the absolute path that will actually be spawned, or
   * `null` if the request is not on the allowlist.
   *
   * Matching rules:
   *   1. If the request is an absolute path and appears in
   *      `allowedExecutables`, return it as-is (after resolving symlinks
   *      so two paths to the same binary both work).
   *   2. If the request is a bare name and an `allowedExecutables` entry
   *      is also a bare name matching exactly, resolve that name via the
   *      safe PATH and return the absolute path. The resolved path must
   *      point to an existing file (a misspelled or missing binary is
   *      refused loudly rather than silently spawning nothing).
   *   3. If an `allowedExecutables` entry is an absolute path whose
   *      basename matches the request, also accept.
   */
  #resolveExecutable(manifest: ToolManifest, requested: string): string | null {
    const list = manifest.allowedExecutables ?? [];
    if (list.length === 0) return null;
    if (!requested || typeof requested !== "string") return null;

    // Strip any path components the model might have included
    // (security: refuse /usr/bin/passwd-style attacks that try to use a
    // bare name to match a different allowlisted absolute path).
    const reqBaseParts = requested.split(/[\\/]/);
    const reqBase: string = reqBaseParts[reqBaseParts.length - 1] ?? requested;
    const reqAbs = isAbsolute(requested) ? resolve(requested) : null;

    // YOLO wildcard: "*" allows ANY binary. PATH-hijack defense is preserved —
    // a bare name is still resolved through the safe PATH (never CWD), and an
    // absolute request must point at a real file.
    if (list.includes("*")) {
      if (reqAbs) return existsSync(reqAbs) ? reqAbs : null;
      const pathEnv: string = this.#config.safeBaseEnv.PATH ?? "";
      return which(reqBase, pathEnv);
    }

    for (const entry of list) {
      // Case A: absolute allowlist entry, absolute request → match paths.
      if (isAbsolute(entry) && reqAbs) {
        if (resolve(entry) === reqAbs) return reqAbs;
        continue;
      }
      // Case B: absolute allowlist entry, bare request → match basename.
      // Compare by stem (extension-insensitive) so a bare `git` request
      // matches an allowlisted absolute `…\git.exe` on Windows, where
      // resolveExecutables() stores the resolved `.exe` path. Without this,
      // every Windows manifest built from bare names was unmatchable.
      if (isAbsolute(entry) && !isAbsolute(requested)) {
        const entryParts = entry.split(/[\\/]/);
        const entryBase: string = entryParts[entryParts.length - 1] ?? entry;
        if (entryBase === reqBase || execStem(entryBase) === execStem(reqBase)) {
          // Resolve the allowlisted path and use IT as the spawn target
          // (not the model's bare name) — this prevents PATH hijacking
          // where /usr/bin/git is allowlisted but a malicious /tmp/git
          // would be found first.
          if (existsSync(entry)) return resolve(entry);
        }
        continue;
      }
      // Case C: bare allowlist entry, bare request → exact name match
      // resolved via safe PATH.
      if (!isAbsolute(entry) && !isAbsolute(requested)) {
        if (entry === requested) {
          // `noUncheckedIndexedAccess` makes Record access yield
          // `string | undefined`; the safe env is constructed with
          // literal values, so the `?? ""` is just a type-narrowing
          // hint and never fires at runtime.
          const pathEnv: string = this.#config.safeBaseEnv.PATH ?? "";
          const found = which(requested, pathEnv);
          if (found) return found;
        }
        continue;
      }
      // Mixed shape (absolute allowlist, absolute request handled above;
      // bare allowlist, absolute request is rejected — the model asked
      // for a specific path that the manifest did not declare).
    }
    return null;
  }

  /**
   * Drain stdout and stderr concurrently while enforcing both an output
   * cap and a timeout. If the cap is exceeded, the underlying process is
   * killed and `truncated` is set on the result.
   */
  async #readWithCap(
    proc: ReturnType<typeof Bun.spawn>,
    cap: number,
    timeoutMs: number,
  ): Promise<{
    stdout: { text: string; timedOut: boolean };
    stderr: { text: string; timedOut: boolean };
    truncated: boolean;
  }> {
    let truncated = false;
    let stdoutTimedOut = false;
    let stderrTimedOut = false;

    // Readers currently blocked in read(); the kill timer cancels them so a
    // timeout actually unblocks us. Killing the direct child alone is not
    // enough on POSIX: a grandchild (e.g. `sleep` under `sh -c`) inherits
    // the stdout pipe and keeps it open, so read() would block until the
    // entire process tree exits — long past the timeout.
    // Structural type: Bun/DOM/node:stream-web reader types disagree across
    // platforms' lib definitions, but all expose cancel().
    const activeReaders: Array<{ cancel(reason?: unknown): Promise<void> }> = [];

    // Timer that aborts the process if the overall timeout is reached.
    const killTimer = setTimeout(() => {
      stdoutTimedOut = true;
      stderrTimedOut = true;
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      for (const r of activeReaders) {
        void r.cancel().catch(() => { /* stream already closed */ });
      }
    }, timeoutMs);

    const readStream = async (
      stream: unknown,
      name: "stdout" | "stderr",
    ): Promise<{ text: string; timedOut: boolean }> => {
      if (!stream || typeof stream === "number") {
        return { text: "", timedOut: false };
      }
      // `stream` is a ReadableStream at runtime; the generic constraints on
      // Bun's Subprocess type make a precise signature impractical. We do
      // a runtime check instead so we never crash on a malformed proc.
      if (typeof (stream as { getReader?: unknown }).getReader !== "function") {
        return { text: "", timedOut: false };
      }
      const safeStream = stream as ReadableStream<Uint8Array>;
      const reader = safeStream.getReader();
      activeReaders.push(reader);
      const decoder = new TextDecoder("utf-8");
      const chunks: string[] = [];
      let total = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            const piece = decoder.decode(value, { stream: true });
            total += value.byteLength;
            if (total > cap) {
              truncated = true;
              const remaining = cap - (total - value.byteLength);
              if (remaining > 0) {
                chunks.push(piece.slice(0, remaining));
              }
              chunks.push(`\n[${name} truncated at ${cap} bytes]`);
              try { proc.kill(); } catch { /* already dead */ }
              try { await reader.cancel(); } catch { /* */ }
              break;
            }
            chunks.push(piece);
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* */ }
      }
      return {
        text: chunks.join(""),
        timedOut: name === "stdout" ? stdoutTimedOut : stderrTimedOut,
      };
    };

    try {
      const [stdout, stderr] = await Promise.all([
        readStream(proc.stdout, "stdout"),
        readStream(proc.stderr, "stderr"),
      ]);
      return { stdout, stderr, truncated };
    } finally {
      clearTimeout(killTimer);
    }
  }
}

/**
 * Minimal `which` implementation: walk `PATH` (colon-separated on POSIX,
 * semicolon-separated on Windows) and return the first existing regular
 * file whose basename matches `name`. Returns null if not found.
 *
 * Pure function, no side effects. Used to resolve bare command names
 * against the safe base PATH so the allowlist check can be performed
 * against an absolute path.
 */
/**
 * Lowercased basename with a Windows executable extension stripped, used for
 * extension-insensitive allowlist matching (`git` ↔ `git.exe`). On POSIX
 * there is normally no extension so this is just a lowercase basename.
 */
function execStem(nameOrPath: string): string {
  const base = (nameOrPath.split(/[\\/]/).pop() ?? nameOrPath).toLowerCase();
  return base.replace(/\.(exe|cmd|bat|com)$/i, "");
}

export function which(name: string, pathEnv: string): string | null {
  if (!name) return null;
  // Reject anything that contains a path separator — that's a sign the
  // caller should have used the absolute-path branch.
  if (/[\\/]/.test(name)) return null;

  const isWin = process.platform === "win32";
  const sep = isWin ? ";" : ":";
  const exts = isWin
    ? (process.env.PATHEXT ?? ".EXE;.BAT;.CMD").split(";")
    : [""];

  for (const dir of pathEnv.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = resolve(dir, name + ext);
      if (existsSync(candidate)) {
        try {
          const stat = Bun.file(candidate);
          // Bun doesn't expose stat via existsSync; use a sync check.
          // For our security purposes, existence is enough — Bun's spawn
          // will surface "not executable" itself.
          void stat;
          return candidate;
        } catch {
          continue;
        }
      }
    }
  }
  return null;
}
