/**
 * Tests for the resolveExecutables helper.
 *
 * This helper is the F0.5 hardening: tool manifests that historically used
 * bare names (["sh"], ["git"]) are converted to absolute paths at module
 * load time. The result is a manifest that the ProcessSandbox matches via
 * Case B (absolute path) instead of Case C (PATH-walk), closing the last
 * PATH-hijack window.
 *
 * The helper must:
 *   1. Resolve a known bare name to an absolute path that exists.
 *   2. Preserve the absolute path if the input is already absolute.
 *   3. Fall back to the bare name (with a warning) if the name cannot be
 *      found on the current PATH — better to keep working than to refuse
 *      to register a tool.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

describe("resolveExecutables", () => {
  let originalPath: string | undefined;
  let resolveExecutables: typeof import("../src/core/executables.ts").resolveExecutables;
  let resolveExecutablesLazy: typeof import("../src/core/executables.ts").resolveExecutablesLazy;

  beforeEach(async () => {
    originalPath = process.env.PATH;
    // Re-import fresh per describe for clean module state.
    const mod = await import(`../src/core/executables.ts?cache=${Math.random()}`);
    resolveExecutables = mod.resolveExecutables;
    resolveExecutablesLazy = mod.resolveExecutablesLazy;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("resolves a known bare name to an absolute path", () => {
    const [resolved] = resolveExecutables([process.platform === "win32" ? "where" : "sh"]);
    expect(resolved).toBeTruthy();
    expect(resolved).toMatch(/[/\\]/); // contains a separator → absolute
  });

  it("preserves an already-absolute path verbatim", () => {
    const abs = process.platform === "win32"
      ? "C:\\Windows\\System32\\cmd.exe"
      : "/bin/sh";
    const [resolved] = resolveExecutables([abs]);
    expect(resolved.toLowerCase()).toBe(abs.toLowerCase());
  });

  it("falls back to the bare name with a warning when not found", () => {
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      const result = resolveExecutables(["definitely-not-a-real-binary-xyzzy12345"]);
      expect(result).toEqual(["definitely-not-a-real-binary-xyzzy12345"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });

  it("resolves a mix of bare names and absolute paths in one call", () => {
    const abs = process.platform === "win32"
      ? "C:\\Windows\\System32\\cmd.exe"
      : "/bin/sh";
    const [r1, r2] = resolveExecutables([process.platform === "win32" ? "where" : "sh", abs]);
    expect(r1).toMatch(/[/\\]/);
    expect(r2.toLowerCase()).toBe(abs.toLowerCase());
  });

  it("caches resolutions so subsequent calls do not re-walk PATH", () => {
    const abs = process.platform === "win32"
      ? "C:\\Windows\\System32\\cmd.exe"
      : "/bin/sh";
    const resolver = resolveExecutablesLazy([abs]);
    const a = resolver("sh");
    const b = resolver("sh");
    expect(a).toBe(b); // same cached value
  });
});
