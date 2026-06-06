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
import type { Permission, ToolManifest } from "../types.ts";

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
    if (!manifest.allowedPaths || manifest.allowedPaths.length === 0) {
      throw new ManifestError(
        `tool "${manifest.name}" has fs permissions but no allowedPaths`,
      );
    }
    for (const p of manifest.allowedPaths) {
      if (!isAbsolute(p)) {
        throw new ManifestError(
          `tool "${manifest.name}" allowedPaths must be absolute: "${p}"`,
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

  const roots = manifest.allowedPaths ?? [];
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

  const contained = roots.some((root) => {
    let normalizedRoot: string;
    try {
      normalizedRoot = realpathSync(root);
    } catch {
      normalizedRoot = resolve(root);
    }
    return (
      target === normalizedRoot ||
      target.startsWith(normalizedRoot + sep)
    );
  });

  if (!contained) {
    throw new PermissionDeniedError(
      `path "${target}" is outside allowedPaths for "${manifest.name}"`,
    );
  }

  return target;
}
