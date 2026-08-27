/**
 * Long-horizon hardening (2026-07-24, second pass). Each check pins one of the
 * failures that only appear once the agent has been working for a while:
 *
 *   - the agent not knowing its own extended tools exist (native-tool providers
 *     strip `## Available tools`, and the schemas sent are core-only)
 *   - a turn with no wall-clock bound (connectors have no Stop button)
 *   - connectors replacing every real error with "something went wrong"
 */
import { describe, expect, test } from "bun:test";
import { buildCapabilityIndex, turnBudgetMs } from "../src/core/agent-loop";
import { connectorErrorMessage } from "../src/transports/connectors";
import { stripToolsFromSystemPrompt } from "../src/egress/inference-providers";
import type { ToolRegistry } from "../src/tools/registry";

function fakeRegistry(names: string[]): ToolRegistry {
  return {
    list: () =>
      names.map((name) => ({
        manifest: { name, description: `Does ${name} things. Extra detail here.` },
      })),
  } as unknown as ToolRegistry;
}

describe("buildCapabilityIndex — the agent must know what it can do", () => {
  test("lists drawer tools the turn's schemas omit", () => {
    const idx = buildCapabilityIndex(fakeRegistry(["read_file", "run_tests", "deep_research"]));
    expect(idx).toContain("run_tests");
    expect(idx).toContain("deep_research");
    // Core tools are already advertised as schemas — no need to repeat them.
    expect(idx).not.toContain("`read_file`");
  });

  test("includes MCP tools, which are always drawer-tier", () => {
    expect(buildCapabilityIndex(fakeRegistry(["mcp_search"]))).toContain("mcp_search");
  });

  test("omits connector-only tools from the owner surface", () => {
    const idx = buildCapabilityIndex(fakeRegistry(["capture_lead", "run_tests"]));
    expect(idx).not.toContain("capture_lead");
    expect(idx).toContain("run_tests");
  });

  test("empty when everything is already core", () => {
    expect(buildCapabilityIndex(fakeRegistry(["read_file", "write_file"]))).toBe("");
  });

  test("tolerates a registry fake without list()", () => {
    expect(buildCapabilityIndex({ describe: () => "" } as unknown as ToolRegistry)).toBe("");
  });

  test("SURVIVES the native-tool prompt strip — the whole point", () => {
    const prompt = [
      "## Available tools",
      "- read_file(path): reads",
      "",
      buildCapabilityIndex(fakeRegistry(["run_tests", "control_app"])),
      "",
      "## Rules",
      "- Be concise.",
    ].join("\n");
    const stripped = stripToolsFromSystemPrompt(prompt);
    // The schema block is gone…
    expect(stripped).not.toContain("- read_file(path): reads");
    // …but the agent still knows these exist.
    expect(stripped).toContain("run_tests");
    expect(stripped).toContain("control_app");
  });
});

describe("turnBudgetMs — bounds time, not just iterations", () => {
  const withEnv = (v: string | undefined, fn: () => void) => {
    const prev = process.env.CINDERPAW_TURN_BUDGET_MS;
    if (v === undefined) delete process.env.CINDERPAW_TURN_BUDGET_MS;
    else process.env.CINDERPAW_TURN_BUDGET_MS = v;
    try { fn(); } finally {
      if (prev === undefined) delete process.env.CINDERPAW_TURN_BUDGET_MS;
      else process.env.CINDERPAW_TURN_BUDGET_MS = prev;
    }
  };

  test("defaults to 20 minutes", () => {
    withEnv(undefined, () => expect(turnBudgetMs()).toBe(20 * 60_000));
  });

  test("honours an override", () => {
    withEnv("300000", () => expect(turnBudgetMs()).toBe(300_000));
  });

  test("clamps absurd values instead of trusting them", () => {
    withEnv("1", () => expect(turnBudgetMs()).toBe(60_000));
    withEnv("999999999", () => expect(turnBudgetMs()).toBe(6 * 3_600_000));
    withEnv("nonsense", () => expect(turnBudgetMs()).toBe(20 * 60_000));
  });
});

describe("connectorErrorMessage — the channel is the only place they can read", () => {
  test("names an auth failure as an owner problem", () => {
    const m = connectorErrorMessage(new Error("inference endpoint … returned 401: invalid api key"));
    expect(m).toMatch(/API key/i);
  });

  test("names a rate limit as temporary", () => {
    expect(connectorErrorMessage(new Error("HTTP 429 rate limit"))).toMatch(/rate-limited/i);
  });

  test("a model that cannot see says so, instead of a generic shrug", () => {
    // Sending a photo to a text-only model is the loud half of a real gap: the
    // three provider shapes all ship images correctly, so nothing on our side
    // drops them, and the person is left reading "something went wrong" about
    // a picture they can see perfectly well. The provider already said why.
    for (const raw of [
      "inference endpoint … returned 400: this model does not support image input",
      "returned 422: messages: image_url is not supported by this model",
      "400 Invalid content type: vision is not enabled for meta/some-model",
      "multimodal input is not supported",
    ]) {
      expect(connectorErrorMessage(new Error(raw))).toMatch(/can'?t see images|text-only/i);
    }
  });

  test("an ordinary 400 is not mistaken for a blind model", () => {
    // The word "image" must not be enough on its own — plenty of failures
    // mention it in passing, and a wrong diagnosis sends the owner to change
    // models over something else entirely.
    expect(connectorErrorMessage(new Error("400: could not parse request body")))
      .not.toMatch(/can'?t see images/i);
  });

  test("names a context overflow with an action", () => {
    expect(connectorErrorMessage(new Error("context length exceeded"))).toMatch(/too long|fresh thread/i);
  });

  test("names the turn budget", () => {
    expect(connectorErrorMessage(new Error("I ran out of time for this turn"))).toMatch(/longer than/i);
  });

  test("still says something concrete for an unknown error", () => {
    const m = connectorErrorMessage(new Error("ENOSPC: no space left on device"));
    expect(m).toContain("ENOSPC");
  });

  test("never leaks a multi-line stack trace into a public channel", () => {
    const err = new Error("boom");
    err.message = "boom\n  at Foo (/home/darius/secret/path.ts:1:1)\n  at Bar";
    const m = connectorErrorMessage(err);
    expect(m).not.toContain("\n");
    expect(m).not.toContain("secret/path");
  });
});
