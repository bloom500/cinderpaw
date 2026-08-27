/**
 * Tests for the USER.md loader.
 *
 * The user-loader reads the per-user personalization record at
 * `~/.cinderpaw/onboarding.json` (written by the onboarding wizard) and
 * exposes the user name + agent name to the system prompt. The
 * record is JSON, not Markdown, because it carries structured
 * fields the agent can format into a USER block.
 *
 * Behavior under failure: any I/O error (missing file, malformed
 * JSON, permission denied) yields a "no personalization" result
 * with empty names — the agent then uses generic defaults. The
 * loader never throws, so a bad onboarding file can never brick
 * the agent.
 */

import { APP_HOME_DIR_NAME } from "../src/brand.ts";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadUserConfig,
  buildUserPromptBlock,
  type UserConfig,
} from "../src/core/user-loader.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cinderpaw-user-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("loadUserConfig", () => {
  it("returns an empty default when no onboarding file exists", () => {
    const cfg = loadUserConfig(home);
    expect(cfg.userName).toBe("");
    expect(cfg.agentName).toBe("Cinderpaw");
    expect(cfg.hasOnboarded).toBe(false);
  });

  it("loads userName and agentName from a valid onboarding file", () => {
    const dir = join(home, APP_HOME_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "onboarding.json"),
      JSON.stringify({
        completed: true,
        completedAt: 1_700_000_000_000,
        userName: "Darius",
        agentName: "Bob",
      }),
    );
    const cfg = loadUserConfig(home);
    expect(cfg.userName).toBe("Darius");
    expect(cfg.agentName).toBe("Bob");
    expect(cfg.hasOnboarded).toBe(true);
  });

  it("falls back to 'Cinderpaw' when agentName is missing or empty", () => {
    const dir = join(home, APP_HOME_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "onboarding.json"),
      JSON.stringify({ completed: true, userName: "X" }),
    );
    expect(loadUserConfig(home).agentName).toBe("Cinderpaw");
  });

  it("treats malformed JSON as no personalization (does not throw)", () => {
    const dir = join(home, APP_HOME_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "onboarding.json"), "{not json");
    const cfg = loadUserConfig(home);
    expect(cfg.userName).toBe("");
    expect(cfg.agentName).toBe("Cinderpaw");
    expect(cfg.hasOnboarded).toBe(false);
  });

  it("treats `completed: false` as not onboarded", () => {
    const dir = join(home, APP_HOME_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "onboarding.json"),
      JSON.stringify({ completed: false, userName: "X" }),
    );
    expect(loadUserConfig(home).hasOnboarded).toBe(false);
  });
});

describe("buildUserPromptBlock", () => {
  it("returns an empty string when the user has not onboarded", () => {
    const empty: UserConfig = {
      userName: "",
      agentName: "Cinderpaw",
      hasOnboarded: false,
    };
    expect(buildUserPromptBlock(empty)).toBe("");
  });

  it("returns a USER block when names are present", () => {
    const cfg: UserConfig = {
      userName: "Darius",
      agentName: "Bob",
      hasOnboarded: true,
    };
    const block = buildUserPromptBlock(cfg);
    expect(block).toContain("Darius");
    expect(block).toContain("Bob");
    expect(block).toContain("USER");
  });

  it("uses the default name 'Cinderpaw' when the user did not pick one", () => {
    const cfg: UserConfig = {
      userName: "Darius",
      agentName: "Cinderpaw",
      hasOnboarded: true,
    };
    const block = buildUserPromptBlock(cfg);
    expect(block).toContain("Darius");
    expect(block).toContain("Cinderpaw");
  });
});
