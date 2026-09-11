/**
 * A model handed native tool schemas must not also be taught the text
 * tool-call format. Teaching both makes it split a call across the two
 * channels: the name arrives natively, the arguments as prose, and the tool
 * runs with no arguments at all.
 *
 * Measured 2026-09-10 on z-ai/glm-5.3-flash via OpenRouter, three requests
 * differing only in whether the system prompt showed `{"name": …, "args": …}`:
 * with it, two of three returned `get_reservation_details` with `{}`; without
 * it, the call carried `{"reservation_id": "EHGLP3"}`. In a real run this hit
 * every tool call after the first — 17 of 21 tool results in a tau2 airline
 * task were "missing 1 required positional argument", and the model's own
 * reasoning blamed itself for "sending empty args".
 *
 * `stripToolsFromSystemPrompt` already removes "## Available tools" and
 * "## How to call a tool" when native schemas are sent. It does NOT touch the
 * capability index, which is why a wire-format example there survived the
 * strip and undid the whole mechanism.
 */
import { describe, it, expect } from "bun:test";
import { buildCapabilityIndex } from "../src/core/agent-loop.ts";
import { stripToolsFromSystemPrompt } from "../src/egress/inference-providers.ts";

/** Minimal registry stub: one tool the index will consider hidden. */
function registryWith(names: string[]): any {
  return {
    list: () =>
      names.map((name) => ({
        manifest: { name, description: `Does ${name}. Second sentence ignored.` },
      })),
  };
}

describe("native tools and the text protocol are never taught together", () => {
  it("the capability index shows no text tool-call syntax", () => {
    // `run_tests` is an extended tool, so it lands in the index.
    const index = buildCapabilityIndex(registryWith(["run_tests"]));
    expect(index).toContain("load_tool");
    expect(index).not.toContain('"args"');
    expect(index).not.toContain('"name":');
    expect(index).not.toContain("<tool_call>");
  });

  it("what survives the strip carries no wire format", () => {
    const prompt = [
      "## CinderpawAgent base",
      "You are CinderpawAgent.",
      "",
      "## How to call a tool",
      '{"name": "tool_name", "args": {"param": "value"}}',
      "",
      buildCapabilityIndex(registryWith(["run_tests"])),
    ].join("\n");

    const sent = stripToolsFromSystemPrompt(prompt);

    expect(sent).toContain("You are CinderpawAgent.");
    expect(sent).not.toContain('"args"');
    expect(sent).not.toContain("<tool_call>");
    expect(sent).not.toContain("How to call a tool");
  });
});
