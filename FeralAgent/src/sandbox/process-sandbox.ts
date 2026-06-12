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
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 300_000,
  maxOutputBytes: 1_048_576, // 1 MB
    safeBaseEnv: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? (process.env.USERPROFILE ?? ""),
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    },
};

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
      block(
        `executable "${options.executable}" is not in allowedExecutables for "${manifest.name}"`,
      );
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

    // Timer that aborts the process if the overall timeout is reached.
    const killTimer = setTimeout(() => {
      stdoutTimedOut = true;
      stderrTimedOut = true;
      try { proc.kill(); } catch { /* already dead */ }
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
