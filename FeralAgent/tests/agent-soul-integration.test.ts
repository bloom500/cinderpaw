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

/** Minimal ToolRegistry stub: only the methods buildSystemPrompt actually calls. */
function fakeRegistry(toolsList: string = "read_file, time_date"): Pick<ToolRegistry, "describe"> {
  return {
    describe: () => toolsList,
  };
}

const sampleSoul: SoulConfig = {
  content: "# Custom Soul\n\nI am the user's customized Feral.",
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
    // Legacy behavior: opener is the "You are Feral..." sentence.
    expect(prompt).toContain("You are Feral, a proactive and helpful AI assistant");
    // Mechanics still present.
    expect(prompt).toContain("## Available tools");
  });

  it("does not duplicate the soul content with the legacy opener when both are present", () => {
    // Defensive: a buggy implementation might still append the legacy opener
    // after prepending the soul. This guarantees the soul is the ONLY identity
    // block, and the legacy sentence is dropped when a soul is provided.
    const prompt = buildSystemPrompt(fakeRegistry() as ToolRegistry, sampleSoul);
    expect(prompt).not.toContain("You are Feral, a proactive and helpful AI assistant");
  });
});
