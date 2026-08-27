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

import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { agentProfileDirs, cfgList } from "../config.ts";
import { permissionMode } from "../core/permission-mode.ts";

/**
 * Canonicalize a path even when it does not exist yet: realpath the deepest
 * existing ancestor (following symlinks) and re-attach the not-yet-created
 * tail. Falls back to a plain resolve() when nothing on the path exists.
 */
export function realpathBestEffort(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // walk up until an ancestor exists, keeping the tail
  }
  const abs = resolve(p);
  let cur = abs;
  const tail: string[] = [];
  while (true) {
    const parent = dirname(cur);
    if (parent === cur) break; // reached filesystem root
    tail.unshift(basename(cur));
    cur = parent;
    try {
      return join(realpathSync(cur), ...tail);
    } catch {
      // ancestor doesn't exist either — keep walking up
    }
  }
  return abs;
}
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
 * Deny wall — paths no fs tool may touch even when an allowed root contains
 * them. Workspace roots are broad by default (the user's whole home dir), so
 * the self-protection guarantee ("the agent can't modify its own brain") and
 * the credential guard live HERE, at call time, instead of restricting which
 * roots may exist:
 *   - the agent's profile dir (RSI repo, db, SOUL, connector secrets) — except
 *     the scratch subtree `<profile>/workspace`, which the agent fully owns.
 *     BOTH ~/.cinderpaw and ~/.feral are walled off, because the rename
 *     migration never deletes the old one.
 *   - ~/.ssh (private keys)
 *   - anything listed in CINDERPAW_FS_DENY (path-list, same separator as PATH)
 * Privileged built-ins that must write inside ~/.feral (e.g. connectors_manage)
 * do NOT route through resolveAllowedPath — they own their fixed path.
 */
function deniedPaths(): { deny: string[]; exempt: string[] } {
  // BOTH profile dirs, always. The rename migration (migrate_home.rs) copies
  // ~/.feral into ~/.cinderpaw and deliberately NEVER deletes the source — so
  // on every migrated machine the old directory keeps a full copy of the
  // connector tokens, byok.json API keys and conversations, forever. Walling
  // off only the current one leaves the other readable by the agent's own fs
  // tools, and which one that is flipped silently the day the host migrated.
  // Denying a directory that does not exist costs nothing; denying only one
  // costs the user their keys.
  const homes = agentProfileDirs().map((h) => realpathBestEffort(h));
  const deny = [
    ...homes,
    realpathBestEffort(resolve(homedir(), ".ssh")),
    ...cfgList("CINDERPAW_FS_DENY").map((p) => realpathBestEffort(p)),
  ];
  return { deny, exempt: homes.map((h) => join(h, "workspace")) };
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
 *   - the deny wall: targets inside ~/.feral (non-scratch), ~/.ssh, or
 *     CINDERPAW_FS_DENY are refused regardless of the allowed roots.
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

  // Read-only mode, enforced at the one place every file-writing tool routes
  // through. Blocking it per tool would be a promise with as many holes as
  // there are write tools, and the next one added would be a hole nobody
  // noticed.
  if (permission === "fs:write" && permissionMode() === "read_only") {
    throw new PermissionDeniedError(
      `read-only mode: "${manifest.name}" may not write "${requestedPath}". ` +
        "Report what you found instead of changing it.",
    );
  }

  const roots = normalizeAllowedPaths(manifest.allowedPaths);
  // realpathSync follows symlinks; resolve() does not. Using realpathSync is
  // the only way to defend against a symlink inside an allowed root that
  // points outside. If the path doesn't exist yet, canonicalize the deepest
  // existing ancestor and re-attach the new tail, so a write-tool can target
  // a brand-new file inside the root — critical on macOS, where tmp dirs
  // live behind the /var → /private/var symlink and a plain resolve() of a
  // not-yet-created file never matches the realpath'd root.
  const target = realpathBestEffort(requestedPath);

  // Deny wall first — an allowed root may legitimately CONTAIN a denied
  // subtree (home contains ~/.feral), so containment success is not enough.
  const { deny, exempt } = deniedPaths();
  const within = (child: string, parent: string): boolean =>
    child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  if (
    deny.some((d) => within(target, d)) &&
    !exempt.some((e) => within(target, e))
  ) {
    throw new PermissionDeniedError(
      `path "${target}" is protected (agent state/credentials) — denied for "${manifest.name}"`,
    );
  }

  // Two checks, in order:
  //   1. Path containment (with symlink-safe realpath)
  //   2. Per-path mode (P0-5) — the new bit. A path declared as
  //      `mode: "read"` cannot be used to satisfy an fs:write call and
  //      vice versa, even if the target IS inside the root. This is the
  //      whole point of the gap.
  const match = roots.find((root) => {
    const normalizedRoot = realpathBestEffort(root.path);
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
