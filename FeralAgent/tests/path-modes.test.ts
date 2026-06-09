/**
 * Per-path access modes — P0-5.
 *
 * The previous `allowedPaths: string[]` form treated every path as
 * read+write. P0-5 introduces `allowedPaths: Array<string | PathAccess>`
 * where PathAccess carries an explicit `mode: "read" | "write" | "read+write"`.
 *
 * Backward compat: bare strings still work, treated as read+write.
 *
 * These tests pin the new behaviour:
 *   1. Manifest validation accepts both forms; bare strings are normalised.
 *   2. resolveAllowedPath enforces the mode (read tool can't write, etc.).
 *   3. Path containment + symlink escape still apply on top of the mode check.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  ManifestError,
  PermissionDeniedError,
  hasPermission,
  normalizeAllowedPaths,
  resolveAllowedPath,
  validateManifest,
} from "../src/sandbox/tool-permissions.ts";
import type { PathAccess, ToolManifest } from "../src/types.ts";

function makeManifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name: "test_tool",
    description: "A test tool for path modes",
    permissions: ["fs:read"],
    networkAccess: false,
    ...overrides,
  };
}

function tempDir(prefix = "feral-path-modes-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("normalizeAllowedPaths", () => {
  test("undefined → []", () => {
    expect(normalizeAllowedPaths(undefined)).toEqual([]);
  });

  test("[] → []", () => {
    expect(normalizeAllowedPaths([])).toEqual([]);
  });

  test("bare strings are wrapped as read+write (backward compat)", () => {
    const dir = "/some/abs/path";
    const result = normalizeAllowedPaths([dir, "/another/abs/path"]);
    expect(result).toEqual([
      { path: dir, mode: "read+write" },
      { path: "/another/abs/path", mode: "read+write" },
    ]);
  });

  test("PathAccess entries are kept verbatim", () => {
    const entries: PathAccess[] = [
      { path: "/abs/a", mode: "read" },
      { path: "/abs/b", mode: "write" },
      { path: "/abs/c", mode: "read+write" },
    ];
    expect(normalizeAllowedPaths(entries)).toEqual(entries);
  });

  test("mixed forms resolve to PathAccess[]", () => {
    const result = normalizeAllowedPaths([
      "/abs/x",
      { path: "/abs/y", mode: "read" },
    ]);
    expect(result).toEqual([
      { path: "/abs/x", mode: "read+write" },
      { path: "/abs/y", mode: "read" },
    ]);
  });
});

describe("validateManifest — path modes", () => {
  test("bare-string allowedPaths still passes (backward compat)", () => {
    const dir = tempDir();
    const m = makeManifest({ allowedPaths: [dir] });
    expect(() => validateManifest(m)).not.toThrow();
  });

  test("PathAccess read mode passes validation", () => {
    const dir = tempDir();
    const m = makeManifest({
      permissions: ["fs:read"],
      allowedPaths: [{ path: dir, mode: "read" }],
    });
    expect(() => validateManifest(m)).not.toThrow();
  });

  test("PathAccess write mode passes validation for fs:write tool", () => {
    const dir = tempDir();
    const m = makeManifest({
      permissions: ["fs:write"],
      allowedPaths: [{ path: dir, mode: "write" }],
    });
    expect(() => validateManifest(m)).not.toThrow();
  });

  test("PathAccess with non-absolute path is rejected", () => {
    const m = makeManifest({
      permissions: ["fs:read"],
      allowedPaths: [{ path: "relative/path", mode: "read" }],
    });
    expect(() => validateManifest(m)).toThrow(ManifestError);
    expect(() => validateManifest(m)).toThrow(/must be absolute/);
  });

  test("empty allowedPaths is still rejected when fs permission declared", () => {
    const m = makeManifest({ permissions: ["fs:read"], allowedPaths: [] });
    expect(() => validateManifest(m)).toThrow(/no allowedPaths/);
  });
});

describe("resolveAllowedPath — mode enforcement", () => {
  test("bare-string entry allows read (treated as read+write)", () => {
    const dir = tempDir();
    const m = makeManifest({ allowedPaths: [dir] });
    const got = resolveAllowedPath(m, "fs:read", dir);
    expect(got).toBe(realpathSync(dir));
  });

  test("bare-string entry allows write (treated as read+write)", () => {
    const dir = tempDir();
    const m = makeManifest({
      permissions: ["fs:read", "fs:write"],
      allowedPaths: [dir],
    });
    const target = join(dir, "x.txt");
    writeFileSync(target, "hello");
    const got = resolveAllowedPath(m, "fs:write", target);
    expect(got).toBe(target);
  });

  test("read-only PathAccess allows read", () => {
    const dir = tempDir();
    const m = makeManifest({
      allowedPaths: [{ path: dir, mode: "read" }],
    });
    const got = resolveAllowedPath(m, "fs:read", dir);
    expect(got).toBe(realpathSync(dir));
  });

  test("read-only PathAccess denies write (the whole point of P0-5)", () => {
    const dir = tempDir();
    const m = makeManifest({
      permissions: ["fs:read", "fs:write"],
      allowedPaths: [{ path: dir, mode: "read" }],
    });
    const target = join(dir, "x.txt");
    expect(() => resolveAllowedPath(m, "fs:write", target)).toThrow(
      PermissionDeniedError,
    );
    try {
      resolveAllowedPath(m, "fs:write", target);
    } catch (e) {
      expect((e as Error).message).toMatch(/read-only|mode/i);
    }
  });

  test("write-only PathAccess allows write", () => {
    const dir = tempDir();
    const m = makeManifest({
      permissions: ["fs:read", "fs:write"],
      allowedPaths: [{ path: dir, mode: "write" }],
    });
    const target = join(dir, "scratch.txt");
    const got = resolveAllowedPath(m, "fs:write", target);
    expect(got).toBe(target);
  });

  test("write-only PathAccess denies read", () => {
    const dir = tempDir();
    const target = join(dir, "x.txt");
    writeFileSync(target, "hello");
    const m = makeManifest({
      permissions: ["fs:read", "fs:write"],
      allowedPaths: [{ path: dir, mode: "write" }],
    });
    expect(() => resolveAllowedPath(m, "fs:read", target)).toThrow(
      PermissionDeniedError,
    );
  });

  test("read+write mode allows both", () => {
    const dir = tempDir();
    const target = join(dir, "x.txt");
    writeFileSync(target, "hi");
    const m = makeManifest({
      permissions: ["fs:read", "fs:write"],
      allowedPaths: [{ path: dir, mode: "read+write" }],
    });
    expect(resolveAllowedPath(m, "fs:read", target)).toBe(target);
    expect(resolveAllowedPath(m, "fs:write", target)).toBe(target);
  });

  test("path outside every allowed root is rejected even if mode matches", () => {
    const allowed = tempDir();
    const outside = tempDir("outside-");
    const m = makeManifest({
      permissions: ["fs:read", "fs:write"],
      allowedPaths: [{ path: allowed, mode: "read+write" }],
    });
    expect(() => resolveAllowedPath(m, "fs:read", outside)).toThrow(
      PermissionDeniedError,
    );
    expect(() => resolveAllowedPath(m, "fs:read", outside)).toThrow(
      /outside allowedPaths/,
    );
  });

  test("missing fs:read permission is rejected before mode check", () => {
    const dir = tempDir();
    const m = makeManifest({
      permissions: ["fs:write"], // no fs:read
      allowedPaths: [{ path: dir, mode: "read+write" }],
    });
    expect(() => resolveAllowedPath(m, "fs:read", dir)).toThrow(
      /lacks fs:read/,
    );
  });

  test("symlink escape is still blocked (defence in depth)", () => {
    const allowed = tempDir("inside-");
    const outside = tempDir("outside-");
    const link = join(allowed, "evil-link");
    try {
      symlinkSync(outside, link);
    } catch (err) {
      // Some Windows configs disallow symlink creation. The unit-level
      // contract we care about (path containment via realpath) is covered
      // by the existing process-sandbox-security suite; here we only need
      // to confirm mode enforcement stacks ON TOP of containment, which
      // the other resolveAllowedPath tests already do.
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }

    const m = makeManifest({
      permissions: ["fs:read"],
      allowedPaths: [{ path: allowed, mode: "read+write" }],
    });
    expect(() => resolveAllowedPath(m, "fs:read", link)).toThrow(
      PermissionDeniedError,
    );
  });
});

describe("hasPermission (unchanged behaviour)", () => {
  test("returns true for declared permissions", () => {
    const m = makeManifest({ permissions: ["fs:read", "fs:write"] });
    expect(hasPermission(m, "fs:read")).toBe(true);
    expect(hasPermission(m, "fs:write")).toBe(true);
  });
});
