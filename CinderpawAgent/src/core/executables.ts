/**
 * Executable resolution — F0.5 hardening helper.
 *
 * Tool manifests that historically used bare names (["sh"], ["git"]) are
 * vulnerable to PATH hijack: a malicious binary placed earlier in PATH
 * could shadow the real one. The ProcessSandbox's Case C (bare-name +
 * PATH-walk) would then spawn the attacker.
 *
 * This module resolves bare names to absolute paths at registration time,
 * so the manifest carries ["/bin/sh"] instead of ["sh"]. The sandbox then
 * matches via Case B (absolute path), which is immune to PATH order.
 *
 * Resolution is performed once at module load and cached. A failed
 * resolution falls back to the bare name with a console.warn — better
 * to keep the tool working than to refuse registration on a misconfigured
 * PATH.
 */

import { which as sandboxWhich } from "../egress/process-sandbox.ts";

/** Source of PATH used for resolution. Defaults to the parent process PATH. */
function getPathEnv(): string {
  return process.env.PATH ?? "";
}

/**
 * Resolve a list of bare names / absolute paths to a list of absolute paths.
 *
 * Inputs that are already absolute are preserved verbatim. Bare names are
 * looked up via `which()` against the parent process PATH; if not found,
 * the bare name is returned as-is and a warning is logged.
 *
 * The result is intended to be stored in `ToolManifest.allowedExecutables`.
 */
export function resolveExecutables(names: string[]): string[] {
  const pathEnv = getPathEnv();
  return names.map((name) => {
    // Preserve absolute paths verbatim — no resolution needed.
    if (name.includes("/") || name.includes("\\")) {
      return name;
    }
    const resolved = sandboxWhich(name, pathEnv);
    if (resolved) return resolved;
    console.warn(
      `[executables] could not resolve "${name}" on PATH — manifest will keep ` +
        `the bare name (PATH-hijack vulnerable if attacker controls PATH)`,
    );
    return name;
  });
}

/**
 * Build a lazy resolver: takes a list of names, resolves them once, and
 * returns a function that looks them up by name. Subsequent calls for the
 * same name return the cached absolute path without re-walking PATH.
 *
 * Useful for code that needs to know the resolved path of a bare name
 * lazily (e.g. tool `execute()` methods that hardcode the bare name).
 */
export function resolveExecutablesLazy(
  names: string[],
): (name: string) => string {
  const map = new Map<string, string>();
  for (const n of names) {
    if (n.includes("/") || n.includes("\\")) {
      map.set(n, n);
    } else {
      const r = sandboxWhich(n, getPathEnv());
      map.set(n, r ?? n);
    }
  }
  return (name: string): string => map.get(name) ?? name;
}
