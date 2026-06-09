/**
 * Tool permission system.
 *
 * Two responsibilities:
 *   1. Validate every tool manifest at registration time. A manifest that is
 *      internally inconsistent (e.g. declares network access but no domains,
 *      or fs permissions but no paths) is rejected — the tool never registers.
 *   2. Enforce permissions at call time. A tool may only touch resources its
 *      manifest declared: filesystem paths inside `allowedPaths`, and (via the
 *      egress proxy) domains inside `allowedDomains`. Any violation is blocked
 *      and audited.
 *
 * The agent can only invoke tools that the registry holds, and the registry
 * only holds tools whose manifests passed validation here — so a tool can
 * never exercise a permission it did not declare.
 */

import { isAbsolute, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { PathAccess, PathMode, Permission, ToolManifest } from "../types.ts";

const ALL_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  "fs:read",
  "fs:write",
  "network:outbound",
  "process:spawn",
]);

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

/**
 * Validate a manifest for internal consistency. Throws ManifestError on any
 * problem; returns normally when the manifest is safe to register.
 */
export function validateManifest(manifest: ToolManifest): void {
  if (!manifest.name || !/^[a-z][a-z0-9_]*$/.test(manifest.name)) {
    throw new ManifestError(
      `invalid tool name "${manifest.name}" (use snake_case)`,
    );
  }
  if (!manifest.description.trim()) {
    throw new ManifestError(`tool "${manifest.name}" needs a description`);
  }

  for (const perm of manifest.permissions) {
    if (!ALL_PERMISSIONS.has(perm)) {
      throw new ManifestError(
        `tool "${manifest.name}" declares unknown permission "${perm}"`,
      );
    }
  }

  const declaresNetwork = manifest.permissions.includes("network:outbound");
  if (declaresNetwork !== manifest.networkAccess) {
    throw new ManifestError(
      `tool "${manifest.name}": networkAccess must match the ` +
        `"network:outbound" permission`,
    );
  }
  if (manifest.networkAccess) {
    if (!manifest.allowedDomains || manifest.allowedDomains.length === 0) {
      throw new ManifestError(
        `tool "${manifest.name}" has network access but no allowedDomains`,
      );
    }
  }

  const declaresFs =
    manifest.permissions.includes("fs:read") ||
    manifest.permissions.includes("fs:write");
  if (declaresFs) {
    const raw = manifest.allowedPaths ?? [];
    if (raw.length === 0) {
      throw new ManifestError(
        `tool "${manifest.name}" has fs permissions but no allowedPaths`,
      );
    }
    // Normalise once so we can validate the path string AND the mode
    // without branching at every check site. Bare strings → read+write
    // (backward compat with V1 manifests).
    for (const entry of normalizeAllowedPaths(raw)) {
      if (!isAbsolute(entry.path)) {
        throw new ManifestError(
          `tool "${manifest.name}" allowedPaths must be absolute: "${entry.path}"`,
        );
      }
    }
  }

  // process:spawn requires a non-empty allowedExecutables allowlist.
  // The ProcessSandbox refuses any executable not on the list, so an
  // empty list would make the tool useless while still passing the
  // registry gate — fail fast at registration instead.
  if (manifest.permissions.includes("process:spawn")) {
    if (
      !manifest.allowedExecutables ||
      manifest.allowedExecutables.length === 0
    ) {
      throw new ManifestError(
        `tool "${manifest.name}" has process:spawn permission but no ` +
          `allowedExecutables allowlist`,
      );
    }
  }
}

/** Whether a manifest declares the given permission. */
export function hasPermission(
  manifest: ToolManifest,
  permission: Permission,
): boolean {
  return manifest.permissions.includes(permission);
}

/**
 * Flatten a manifest's `allowedPaths` (which can mix bare strings and
 * {@link PathAccess} entries) into a uniform `PathAccess[]`. Bare strings
 * are treated as `"read+write"` so the V1 manifest shape keeps working.
 *
 * Pure, exported for use by tools that want to render their own permission
 * summary (e.g. the `tool_health` self-diagnosis).
 */
export function normalizeAllowedPaths(
  allowedPaths: ReadonlyArray<string | PathAccess> | undefined,
): PathAccess[] {
  if (!allowedPaths) return [];
  const out: PathAccess[] = [];
  for (const entry of allowedPaths) {
    if (typeof entry === "string") {
      out.push({ path: entry, mode: "read+write" });
    } else {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Convenience for tools that want to fall back to "the first allowed root"
 * when the caller didn't pass a path. Returns the path string, or
 * `undefined` when the manifest has no fs roots declared.
 *
 * Kept tiny on purpose: tools that need the per-path mode should call
 * {@link normalizeAllowedPaths} directly.
 */
export function firstAllowedPath(manifest: ToolManifest): string | undefined {
  const first = manifest.allowedPaths?.[0];
  if (first === undefined) return undefined;
  return typeof first === "string" ? first : first.path;
}

/**
 * True when a path with the given mode may be used to satisfy the requested
 * permission. `read+write` permits both; a path declared as `"read"` cannot
 * be used to satisfy an `fs:write` request and vice versa.
 */
function modePermits(
  mode: PathMode,
  permission: Extract<Permission, "fs:read" | "fs:write">,
): boolean {
  if (mode === "read+write") return true;
  if (permission === "fs:read") return mode === "read";
  return mode === "write";
}

/**
 * Resolve and validate a filesystem path against a tool's manifest. Returns the
 * absolute, normalized path when allowed; throws PermissionDeniedError when the
 * requested permission is undeclared or the path escapes every allowed root.
 *
 * Guards against:
 *   - directory-traversal: the resolved path must be contained within one of
 *     the declared roots
 *   - symlink escape: a symlink inside an allowed root that points OUTSIDE
 *     the root must not be followed. We resolve the REAL path of the target
 *     (following symlinks) and check containment against THAT.
 */
export function resolveAllowedPath(
  manifest: ToolManifest,
  permission: Extract<Permission, "fs:read" | "fs:write">,
  requestedPath: string,
): string {
  if (!hasPermission(manifest, permission)) {
    throw new PermissionDeniedError(
      `tool "${manifest.name}" lacks ${permission}`,
    );
  }

  const roots = normalizeAllowedPaths(manifest.allowedPaths);
  // realpathSync follows symlinks; resolve() does not. Using realpathSync is
  // the only way to defend against a symlink inside an allowed root that
  // points outside. If the path doesn't exist yet, fall back to resolve() so
  // a write-tool can target a brand-new file inside the root.
  let target: string;
  try {
    target = realpathSync(requestedPath);
  } catch {
    target = resolve(requestedPath);
  }

  // Two checks, in order:
  //   1. Path containment (with symlink-safe realpath)
  //   2. Per-path mode (P0-5) — the new bit. A path declared as
  //      `mode: "read"` cannot be used to satisfy an fs:write call and
  //      vice versa, even if the target IS inside the root. This is the
  //      whole point of the gap.
  const match = roots.find((root) => {
    let normalizedRoot: string;
    try {
      normalizedRoot = realpathSync(root.path);
    } catch {
      normalizedRoot = resolve(root.path);
    }
    return (
      target === normalizedRoot ||
      target.startsWith(normalizedRoot + sep)
    );
  });

  if (!match) {
    throw new PermissionDeniedError(
      `path "${target}" is outside allowedPaths for "${manifest.name}"`,
    );
  }

  if (!modePermits(match.mode, permission)) {
    throw new PermissionDeniedError(
      `path "${target}" is declared as "${match.mode}" for "${manifest.name}", ` +
        `which does not permit ${permission}`,
    );
  }

  return target;
}
