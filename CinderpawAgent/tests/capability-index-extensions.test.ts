/**
 * The capability index, and the part of it the USER controls the size of.
 *
 * Built-in drawer tools are a fixed set we chose. Extension (MCP) tools arrive
 * with whatever servers someone installs, and every line in this index is paid
 * on EVERY completion for the life of the conversation. Measured on Darius's
 * machine: three servers, 41 tools, ~2.6K tokens per completion. Someone with
 * ten servers pays several thousand — for a menu they read once.
 *
 * So the contract these tests pin is: extensions stay DISCOVERABLE (the name is
 * what `load_tool` takes) and stop being DESCRIBED (that is what `list_tools`
 * is for). Awareness preserved, rent removed.
 */

import { describe, expect, test } from "bun:test";
import { buildCapabilityIndex } from "../src/core/agent-loop.ts";
import type { ToolRegistry } from "../src/tools/registry.ts";

function fakeRegistry(names: string[]): ToolRegistry {
  return {
    list: () =>
      names.map((name) => ({
        manifest: {
          name,
          description: `Does ${name} things, at length, with a second sentence nobody needs every turn.`,
        },
      })),
  } as unknown as ToolRegistry;
}

const mcpNames = (n: number) => Array.from({ length: n }, (_, i) => `mcp_extension_tool_${i}`);

describe("extensions are named, not described", () => {
  test("an MCP tool still appears, so the agent knows it exists", () => {
    const index = buildCapabilityIndex(fakeRegistry(["mcp_search"]));
    expect(index).toContain("mcp_search");
    // The description is what got dropped — `list_tools` still has it.
    expect(index).not.toContain("Does mcp_search things");
    expect(index).toContain("list_tools");
  });

  test("built-in drawer tools keep their descriptions", () => {
    const index = buildCapabilityIndex(fakeRegistry(["run_tests", "mcp_search"]));
    expect(index).toContain("Does run_tests things");
    expect(index).not.toContain("Does mcp_search things");
  });

  test("the count is stated, because a number is what makes a menu skimmable", () => {
    expect(buildCapabilityIndex(fakeRegistry(mcpNames(41)))).toContain("(41)");
  });

  test("41 extension tools cost a fraction of what they used to", () => {
    const index = buildCapabilityIndex(fakeRegistry(mcpNames(41)));
    // One line per tool at ~90 characters of description was the old shape.
    const oldShape = 41 * 90;
    expect(index.length).toBeLessThan(oldShape / 2);
    // Every name survives — this is the half that must not regress.
    for (const name of mcpNames(41)) expect(index).toContain(name);
  });

  test("no extensions installed means no extension section at all", () => {
    const index = buildCapabilityIndex(fakeRegistry(["run_tests"]));
    expect(index).not.toContain("From your installed extensions");
  });

  test("still empty when everything is core — nothing to announce", () => {
    expect(buildCapabilityIndex(fakeRegistry(["read_file", "write_file"]))).toBe("");
  });
});
