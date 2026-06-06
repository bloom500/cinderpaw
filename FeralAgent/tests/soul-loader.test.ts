/**
 * Tests for the SOUL.md loader.
 *
 * The soul loader reads the agent identity document at startup and supports
 * hot-reload from a user override. These tests use a per-test isolated home
 * directory to avoid touching the real `~/.feral/SOUL.md`.
 *
 * The loader takes an explicit `homeDir` parameter so tests can isolate the
 * user-override lookup without monkey-patching os.homedir.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  loadSoul,
  watchSoul,
  resolveSoulPaths,
  SOFT_CAP_TOKENS,
  HARD_WARN_TOKENS,
} from "../src/core/soul-loader.ts";

describe("resolveSoulPaths", () => {
  it("returns bundled path and resolved user path for a given home", () => {
    const home = join(sep + "home", "test");
    const paths = resolveSoulPaths(home);
    expect(paths.bundled).toMatch(/SOUL\.md$/);
    expect(paths.user).toBe(join(home, ".feral", "SOUL.md"));
  });
});

describe("loadSoul", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "feral-soul-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns bundled SOUL when no user override exists", () => {
    const soul = loadSoul(home);
    expect(soul.content).toContain("Feral Agent");
    expect(soul.content).toContain("Identity");
    expect(soul.source).toBe("bundled");
  });

  it("prefers user override when ~/.feral/SOUL.md exists", () => {
    const feralDir = join(home, ".feral");
    mkdirSync(feralDir, { recursive: true });
    writeFileSync(join(feralDir, "SOUL.md"), "# My Custom Feral\n\nI am the user's version.");

    const soul = loadSoul(home);
    expect(soul.content).toBe("# My Custom Feral\n\nI am the user's version.");
    expect(soul.source).toBe("user");
  });

  it("computes a stable version hash for unchanged content", () => {
    const a = loadSoul(home);
    const b = loadSoul(home);
    expect(a.version).toBe(b.version);
    expect(a.version).toMatch(/^[a-f0-9]{8}$/);
  });

  it("version hash changes when content changes", () => {
    const a = loadSoul(home);

    const feralDir = join(home, ".feral");
    mkdirSync(feralDir, { recursive: true });
    writeFileSync(join(feralDir, "SOUL.md"), "# Edited\n\nDifferent content entirely.");
    const b = loadSoul(home);

    expect(a.version).not.toBe(b.version);
  });

  it("records loadedAt timestamp as a recent number", () => {
    const soul = loadSoul(home);
    expect(typeof soul.loadedAt).toBe("number");
    expect(soul.loadedAt).toBeGreaterThan(0);
    // Within the last minute (sanity check that it's "now", not epoch).
    expect(Date.now() - soul.loadedAt).toBeLessThan(60_000);
  });

  it("emits a console warning when SOUL exceeds soft cap", () => {
    const feralDir = join(home, ".feral");
    mkdirSync(feralDir, { recursive: true });
    // ~50KB ≈ 12.5K tokens (4 chars/token heuristic) — well over both caps
    const huge = "# Big Soul\n\n" + "x".repeat(50_000);
    writeFileSync(join(feralDir, "SOUL.md"), huge);

    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      loadSoul(home);
      expect(warn).toHaveBeenCalled();
      const message = String(warn.mock.calls[0]?.[0] ?? "");
      expect(message).toMatch(/SOUL/i);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("exposes soft and hard cap constants", () => {
    expect(SOFT_CAP_TOKENS).toBeGreaterThan(0);
    expect(HARD_WARN_TOKENS).toBeGreaterThan(SOFT_CAP_TOKENS);
  });
});

describe("watchSoul", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "feral-soul-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns a no-op cleanup when no user override exists", () => {
    const cleanup = watchSoul(home, () => {
      throw new Error("should not be called when no user override");
    });
    expect(typeof cleanup).toBe("function");
    cleanup(); // must not throw
  });

  it("invokes the callback with the new soul when user override changes", async () => {
    const feralDir = join(home, ".feral");
    mkdirSync(feralDir, { recursive: true });
    const userSoul = join(feralDir, "SOUL.md");
    writeFileSync(userSoul, "# v1");

    const calls: string[] = [];
    const cleanup = watchSoul(home, (soul) => {
      calls.push(soul.content);
    });

    // Give the watcher a tick to attach.
    await new Promise((r) => setTimeout(r, 50));

    writeFileSync(userSoul, "# v2 — updated");

    // Poll for the callback (fs.watch latency varies by platform).
    for (let i = 0; i < 40 && calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toContain("v2");

    cleanup();
  });
});
