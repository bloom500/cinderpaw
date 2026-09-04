/**
 * Tests for the SOUL.md loader.
 *
 * The soul loader reads the agent identity document at startup and supports
 * hot-reload from a user override. These tests use a per-test isolated home
 * directory to avoid touching the real `~/.cinderpaw/SOUL.md`.
 *
 * The loader takes an explicit `homeDir` parameter so tests can isolate the
 * user-override lookup without monkey-patching os.homedir.
 */

import { APP_HOME_DIR_NAME } from "../src/brand.ts";
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
    expect(paths.user).toBe(join(home, APP_HOME_DIR_NAME, "SOUL.md"));
  });
});

describe("loadSoul", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cinderpaw-soul-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns bundled SOUL when no user override exists", () => {
    const soul = loadSoul(home);
    expect(soul.content).toContain("Cinderpaw");
    expect(soul.content).toContain("Identity");
    expect(soul.source).toBe("bundled");
  });

  it("prefers user override when ~/.cinderpaw/SOUL.md exists", () => {
    const cinderpawDir = join(home, APP_HOME_DIR_NAME);
    mkdirSync(cinderpawDir, { recursive: true });
    writeFileSync(join(cinderpawDir, "SOUL.md"), "# My Custom Cinderpaw\n\nI am the user's version.");

    const soul = loadSoul(home);
    // The user's SOUL replaces the bundled one; the bundled IDENTITY.md and
    // AGENTS.md companions are still appended after it.
    expect(soul.content).toStartWith("# My Custom Cinderpaw\n\nI am the user's version.");
    expect(soul.content).toContain("Cinderpaw — Identity");
    expect(soul.source).toBe("user");
  });

  it("appends bundled IDENTITY.md and AGENTS.md companions", () => {
    const soul = loadSoul(home);
    expect(soul.content).toContain("Cinderpaw — Identity");
    expect(soul.content).toContain("Working Habits");
  });

  it("persona is WHO without the working manual", () => {
    // A voice call is briefed with this once and has exactly one tool, so
    // AGENTS.md — the text agent's operating manual — is four kilobytes about
    // a job the caller is not doing, crowding out the part that decides how it
    // sounds. The call sounded like an appliance until this split existed.
    const soul = loadSoul(home);
    expect(soul.persona).toContain("Cinderpaw — Soul");
    expect(soul.persona).toContain("Cinderpaw — Identity");
    expect(soul.persona).not.toContain("Working Habits");
    // The text agent still gets everything; only the voice brief is narrowed.
    expect(soul.content).toContain("Working Habits");
    expect(soul.content.length).toBeGreaterThan(soul.persona.length);
  });

  it("persona honours a user override too", () => {
    const cinderpawDir = join(home, APP_HOME_DIR_NAME);
    mkdirSync(cinderpawDir, { recursive: true });
    writeFileSync(join(cinderpawDir, "SOUL.md"), "# My Own Cub");

    const soul = loadSoul(home);
    expect(soul.persona).toContain("# My Own Cub");
    expect(soul.persona).not.toContain("Working Habits");
  });

  it("prefers per-file user overrides for companions", () => {
    const cinderpawDir = join(home, APP_HOME_DIR_NAME);
    mkdirSync(cinderpawDir, { recursive: true });
    writeFileSync(join(cinderpawDir, "IDENTITY.md"), "# Custom Identity Override");

    const soul = loadSoul(home);
    expect(soul.content).toContain("# Custom Identity Override");
    expect(soul.content).not.toContain("Cinderpaw — Identity");
    // AGENTS.md still falls back to the bundled copy.
    expect(soul.content).toContain("Working Habits");
  });

  it("computes a stable version hash for unchanged content", () => {
    const a = loadSoul(home);
    const b = loadSoul(home);
    expect(a.version).toBe(b.version);
    expect(a.version).toMatch(/^[a-f0-9]{8}$/);
  });

  it("version hash changes when content changes", () => {
    const a = loadSoul(home);

    const cinderpawDir = join(home, APP_HOME_DIR_NAME);
    mkdirSync(cinderpawDir, { recursive: true });
    writeFileSync(join(cinderpawDir, "SOUL.md"), "# Edited\n\nDifferent content entirely.");
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
    const cinderpawDir = join(home, APP_HOME_DIR_NAME);
    mkdirSync(cinderpawDir, { recursive: true });
    // ~50KB ≈ 12.5K tokens (4 chars/token heuristic) — well over both caps
    const huge = "# Big Soul\n\n" + "x".repeat(50_000);
    writeFileSync(join(cinderpawDir, "SOUL.md"), huge);

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
    home = mkdtempSync(join(tmpdir(), "cinderpaw-soul-"));
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
    const cinderpawDir = join(home, APP_HOME_DIR_NAME);
    mkdirSync(cinderpawDir, { recursive: true });
    const userSoul = join(cinderpawDir, "SOUL.md");
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
