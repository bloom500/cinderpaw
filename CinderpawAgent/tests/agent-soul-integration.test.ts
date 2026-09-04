/**
 * Tests for SOUL integration in the agent-loop system prompt.
 *
 * The SOUL content must:
 *  1. Appear as the FIRST block of the system prompt (highest priority)
 *  2. Not be mutated, trimmed, or "improved" by the loader
 *  3. Be followed by the existing tool-calling mechanics (tools list, format)
 *  4. Fall back to the legacy opener when no soul is provided (backwards compat)
 */

import { describe, expect, it } from "bun:test";

import { buildSystemPrompt } from "../src/core/agent-loop.ts";
import type { ToolRegistry } from "../src/tools/registry.ts";
import type { SoulConfig } from "../src/core/soul-loader.ts";
import type { UserConfig } from "../src/core/user-loader.ts";

/** Minimal ToolRegistry stub: only the methods buildSystemPrompt actually calls. */
function fakeRegistry(toolsList: string = "read_file, time_date"): Pick<ToolRegistry, "describe"> {
  return {
    describe: () => toolsList,
  };
}

const sampleSoul: SoulConfig = {
  content: "# Custom Soul\n\nI am the user's customized Cinderpaw.",
  source: "user",
  version: "abcdef12",
  loadedAt: 1_700_000_000_000,
  approxTokens: 12,
};

describe("buildSystemPrompt — soul integration", () => {
  it("prepends the soul content as the first block when a soul is given", () => {
    const prompt = buildSystemPrompt(fakeRegistry() as ToolRegistry, sampleSoul);
    const soulIdx = prompt.indexOf("# Custom Soul");
    const toolsIdx = prompt.indexOf("## Available tools");
    expect(soulIdx).toBeGreaterThanOrEqual(0);
    expect(toolsIdx).toBeGreaterThan(soulIdx);
  });

  it("preserves the soul content verbatim — no mutation", () => {
    const prompt = buildSystemPrompt(fakeRegistry() as ToolRegistry, sampleSoul);
    expect(prompt).toContain(sampleSoul.content);
  });

  it("still includes the tool-call mechanics after the soul", () => {
    const prompt = buildSystemPrompt(fakeRegistry() as ToolRegistry, sampleSoul);
    expect(prompt).toContain("## How to call a tool");
    expect(prompt).toContain("```tool");
    expect(prompt).toContain("## Rules");
  });

  it("includes the tool registry's `describe()` output", () => {
    const prompt = buildSystemPrompt(
      fakeRegistry("read_file, write_file, time_date") as ToolRegistry,
      sampleSoul,
    );
    expect(prompt).toContain("read_file, write_file, time_date");
  });

  it("falls back to the legacy opener when no soul is provided", () => {
    const prompt = buildSystemPrompt(fakeRegistry() as ToolRegistry);
    // Legacy behavior: opener is the "You are Cinderpaw..." sentence.
    expect(prompt).toContain("You are Cinderpaw, a proactive and helpful AI assistant");
    // Mechanics still present.
    expect(prompt).toContain("## Available tools");
  });

  it("does not duplicate the soul content with the legacy opener when both are present", () => {
    // Defensive: a buggy implementation might still append the legacy opener
    // after prepending the soul. This guarantees the soul is the ONLY identity
    // block, and the legacy sentence is dropped when a soul is provided.
    const prompt = buildSystemPrompt(fakeRegistry() as ToolRegistry, sampleSoul);
    expect(prompt).not.toContain("You are Cinderpaw, a proactive and helpful AI assistant");
  });
});

describe("buildSystemPrompt — USER block integration", () => {
  const sampleUser: UserConfig = {
    userName: "Darius",
    agentName: "Bob",
    agentCharacter: {},
    hasOnboarded: true,
  };

  it("injects the USER block when the user has onboarded", () => {
    const prompt = buildSystemPrompt(fakeRegistry() as ToolRegistry, sampleSoul, sampleUser);
    expect(prompt).toContain("Darius");
    expect(prompt).toContain("Bob");
  });

  it("places the USER block after SOUL but before the tool mechanics", () => {
    const prompt = buildSystemPrompt(fakeRegistry() as ToolRegistry, sampleSoul, sampleUser);
    const soulIdx = prompt.indexOf("# Custom Soul");
    const userIdx = prompt.indexOf("Darius");
    const toolsIdx = prompt.indexOf("## Available tools");
    expect(soulIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(soulIdx);
    expect(toolsIdx).toBeGreaterThan(userIdx);
  });

  it("omits the USER block when the user has not onboarded", () => {
    const prompt = buildSystemPrompt(
      fakeRegistry() as ToolRegistry,
      sampleSoul,
      { userName: "", agentName: "Cinderpaw", hasOnboarded: false },
    );
    expect(prompt).not.toContain("Darius");
    expect(prompt).not.toContain("Personalization");
  });

  it("omits the USER block when user is null", () => {
    const prompt = buildSystemPrompt(fakeRegistry() as ToolRegistry, sampleSoul, null);
    expect(prompt).not.toContain("Personalization");
  });

  it("works without a soul — just the USER block + tool mechanics", () => {
    const prompt = buildSystemPrompt(fakeRegistry() as ToolRegistry, null, sampleUser);
    expect(prompt).toContain("Darius");
    expect(prompt).toContain("Bob");
    // Falls back to the legacy opener when no soul is present.
    expect(prompt).toContain("You are Cinderpaw, a proactive and helpful AI assistant");
  });
});
