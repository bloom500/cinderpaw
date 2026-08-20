/**
 * Instance paths — single source of truth for per-tenant storage locations.
 *
 * Contract under test:
 *   1. `paths()` returns the v1 shared layout (every tenant gets the
 *      same paths today; per-instance split is a future change).
 *   2. `paths("default")` equals `paths()`.
 *   3. Every path field is under the same root.
 *   4. `assertTenant` rejects empty / non-string / path-separator /
 *      parent-escape / shell-metacharacter inputs.
 *   5. The same tenant id always resolves to the same paths (pure).
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertTenant,
  DEFAULT_TENANT,
  paths,
  type InstancePaths,
} from "../src/rsi/infra/instance-paths.ts";

describe("DEFAULT_TENANT", () => {
  test("is the literal string 'default'", () => {
    expect(DEFAULT_TENANT).toBe("default");
  });
});

describe("paths() — v1 shared layout", () => {
  test("returns paths() === paths('default')", () => {
    expect(paths()).toEqual(paths(DEFAULT_TENANT));
  });

  test("every tenant resolves to the same root (v1 shared)", () => {
    expect(paths("a").root).toBe(paths("b").root);
    expect(paths("alice").root).toBe(paths("bob").root);
  });

  test("root is under ~/.feral/rsi/", () => {
    const root = paths().root;
    expect(root).toBe(join(homedir(), ".feral", "rsi"));
  });

  test("every path field is under the root", () => {
    const p = paths();
    expect(p.auditLog.startsWith(p.root)).toBe(true);
    expect(p.champion.startsWith(p.root)).toBe(true);
    expect(p.journalDir.startsWith(p.root)).toBe(true);
    expect(p.tasteState.startsWith(p.root)).toBe(true);
    expect(p.envelopes.startsWith(p.root)).toBe(true);
    expect(p.gitSubstrate.startsWith(p.root)).toBe(true);
  });

  test("known files live at their expected names", () => {
    const p = paths();
    expect(p.auditLog).toBe(join(p.root, "sandbox_bounds.audit.log"));
    expect(p.champion).toBe(join(p.root, "champion.json"));
    expect(p.tasteState).toBe(join(p.root, "pbt_state.json"));
  });

  test("paths() is a pure function (same input → same output)", () => {
    const a = paths("alice");
    const b = paths("alice");
    expect(a).toEqual(b);
  });

  test("returns the full InstancePaths shape", () => {
    const p: InstancePaths = paths();
    expect(typeof p.root).toBe("string");
    expect(typeof p.auditLog).toBe("string");
    expect(typeof p.champion).toBe("string");
    expect(typeof p.journalDir).toBe("string");
    expect(typeof p.tasteState).toBe("string");
    expect(typeof p.envelopes).toBe("string");
    expect(typeof p.gitSubstrate).toBe("string");
  });
});

describe("assertTenant — input validation", () => {
  test("accepts a plain alphanumeric id", () => {
    expect(() => assertTenant("alice")).not.toThrow();
    expect(() => assertTenant("user-1234")).not.toThrow();
    expect(() => assertTenant("abc_def_ghi")).not.toThrow();
  });

  test("accepts the default tenant id", () => {
    expect(() => assertTenant(DEFAULT_TENANT)).not.toThrow();
  });

  test("rejects empty string", () => {
    expect(() => assertTenant("")).toThrow(/non-empty/);
  });

  test("rejects non-string", () => {
    expect(() => assertTenant(null as unknown as string)).toThrow();
    expect(() => assertTenant(undefined as unknown as string)).toThrow();
    expect(() => assertTenant(42 as unknown as string)).toThrow();
  });

  test("rejects parent-directory escape", () => {
    expect(() => assertTenant("..")).toThrow(/separator/);
    expect(() => assertTenant("../etc/passwd")).toThrow(/separator/);
    expect(() => assertTenant("foo/..")).toThrow(/separator/);
  });

  test("rejects forward slashes (path injection)", () => {
    expect(() => assertTenant("a/b")).toThrow(/separator/);
    expect(() => assertTenant("/etc/passwd")).toThrow(/separator/);
  });

  test("rejects backslashes (Windows path injection)", () => {
    expect(() => assertTenant("a\\b")).toThrow(/separator/);
    expect(() => assertTenant("..\\..\\windows")).toThrow(/separator/);
  });

  test("rejects shell metacharacters (paranoid)", () => {
    expect(() => assertTenant("a;b")).toThrow(/forbidden/);
    expect(() => assertTenant("a&b")).toThrow(/forbidden/);
    expect(() => assertTenant("a|b")).toThrow(/forbidden/);
    expect(() => assertTenant("`whoami`")).toThrow(/forbidden/);
    expect(() => assertTenant("$HOME")).toThrow(/forbidden/);
    expect(() => assertTenant("a\nb")).toThrow(/forbidden/);
  });
});

describe("path computation uses the validated tenant", () => {
  test("a path traversal attempt fails fast before any fs call", () => {
    // If assertTenant runs first, no path is computed for a bad tenant.
    expect(() => paths("../etc/passwd")).toThrow(/separator/);
    expect(() => paths("/etc/passwd")).toThrow(/separator/);
    expect(() => paths("")).toThrow(/non-empty/);
  });

  test("valid tenant → paths compute without throwing", () => {
    expect(() => paths("alice")).not.toThrow();
    expect(() => paths("user-1")).not.toThrow();
  });
});