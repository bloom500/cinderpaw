/**
 * Tests for the FeralAgent base system prompt and continuation helpers.
 *
 * Covers:
 *   1. `FERAL_AGENT_BASE_PROMPT` — universal prompt content + key phrases
 *   2. `buildToolContinuation` — the short re-engagement nudge
 *   3. `buildMidConversationReminder` — the longer SUMMARY/GOAL/LAST-RESULT payload
 *   4. Integration with `buildSystemPrompt` — base is FIRST, never replaced by SOUL
 *   5. Integration with `AgentLoop` — the continuation is appended to the live
 *      transcript after every tool result, so the next completion sees it
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop, buildSystemPrompt } from "../src/core/agent-loop.ts";
import {
  FERAL_AGENT_BASE_PROMPT,
  buildMidConversationReminder,
  buildToolContinuation,
} from "../src/core/feral-prompt.ts";
import { AuditLog } from "../src/sandbox/audit-log.ts";
import { EgressProxy } from "../src/sandbox/egress-proxy.ts";
import { InferenceRouter } from "../src/sandbox/inference-router.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { createReadFileTool } from "../src/tools/builtin/read-file.ts";
import type { OutboundEvent } from "../src/types.ts";
import { openDatabase, type FeralDb } from "../src/db.ts";
import type { ToolRegistry as ToolRegistryType } from "../src/tools/registry.ts";
import type { SoulConfig } from "../src/core/soul-loader.ts";
import type { UserConfig } from "../src/core/user-loader.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BUDGET = {
  perConversation: 50_000,
  perDay: 500_000,
  onExhausted: "stop",
} as const;

function fakeRegistry(toolsList = "read_file, time_date"): Pick<ToolRegistryType, "describe"> {
  return { describe: () => toolsList };
}

const sampleSoul: SoulConfig = {
  content: "# Custom Soul\n\nI am the user's customized Feral.",
  source: "user",
  version: "abcdef12",
  loadedAt: 1_700_000_000_000,
  approxTokens: 12,
};

const sampleUser: UserConfig = {
  userName: "Darius",
  agentName: "Bob",
  hasOnboarded: true,
};

// ---------------------------------------------------------------------------
// 1. FERAL_AGENT_BASE_PROMPT — content tests
// ---------------------------------------------------------------------------

describe("FERAL_AGENT_BASE_PROMPT", () => {
  it("identifies the agent as FeralAgent", () => {
    expect(FERAL_AGENT_BASE_PROMPT).toContain("You are FeralAgent");
  });

  it("encodes the three core principles", () => {
    expect(FERAL_AGENT_BASE_PROMPT).toContain("Task Completion First");
    expect(FERAL_AGENT_BASE_PROMPT).toContain("Reliability like a Toyota");
    expect(FERAL_AGENT_BASE_PROMPT).toContain("Think step-by-step, act decisively");
  });

  it("includes the chain-of-thought / reasoning & planning section", () => {
    expect(FERAL_AGENT_BASE_PROMPT).toContain("Reasoning & Planning");
    expect(FERAL_AGENT_BASE_PROMPT).toContain("Anticipate possible failures and prepare fallbacks");
  });

  it("includes the tool-usage rules", () => {
    expect(FERAL_AGENT_BASE_PROMPT).toContain("Tool Usage Rules (CRITICAL)");
    expect(FERAL_AGENT_BASE_PROMPT).toContain("ALWAYS output tool calls in the precise format");
    expect(FERAL_AGENT_BASE_PROMPT).toContain("Never hallucinate tool results");
  });

  it("includes the self-correction / persistence section", () => {
    expect(FERAL_AGENT_BASE_PROMPT).toContain("Self-Correction & Persistence");
    expect(FERAL_AGENT_BASE_PROMPT).toContain("If you get stuck");
  });
});

// ---------------------------------------------------------------------------
// 2. buildToolContinuation — short re-engagement nudge
// ---------------------------------------------------------------------------

describe("buildToolContinuation", () => {
  it("returns the canonical nudge format", () => {
    const out = buildToolContinuation("tool said 42");
    expect(out).toBe("Previous tool result: tool said 42. Continue towards completing the original goal.");
  });

  it("preserves the full result when under the truncation threshold", () => {
    const result = "x".repeat(1_500);
    const out = buildToolContinuation(result);
    expect(out).toContain(result);
    expect(out).not.toContain("truncated for brevity");
  });

  it("truncates results over the threshold and includes a marker", () => {
    const result = "y".repeat(5_000);
    const out = buildToolContinuation(result);
    expect(out).toContain("…(truncated for brevity)");
    expect(out.length).toBeLessThan(result.length); // strictly shorter than the raw result
    // Truncation should keep the first chunk of the result.
    expect(out).toContain("y".repeat(2_000));
  });

  it("handles an empty result without crashing", () => {
    const out = buildToolContinuation("");
    expect(out).toBe(
      "Previous tool result: . Continue towards completing the original goal.",
    );
  });

  it("preserves newlines and special characters in the result", () => {
    const out = buildToolContinuation('{"a": 1}\nline2\n  spaced');
    expect(out).toContain('{"a": 1}\nline2\n  spaced');
  });

  it("does not mutate the input string", () => {
    const input = "hello world";
    const snapshot = input;
    buildToolContinuation(input);
    expect(input).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// 3. buildMidConversationReminder — long resumption payload
// ---------------------------------------------------------------------------

describe("buildMidConversationReminder", () => {
  it("always opens with the continue-from-where-you-left-off line", () => {
    const out = buildMidConversationReminder({
      summary: "step 1 done",
      goal: "ship the report",
    });
    expect(out.startsWith("Continue from where you left off.")).toBe(true);
  });

  it("includes the summary and the original goal", () => {
    const out = buildMidConversationReminder({
      summary: "fetched 3 sources",
      goal: "compare Postgres and SQLite",
    });
    expect(out).toContain("Current task progress: fetched 3 sources");
    expect(out).toContain("Original goal: compare Postgres and SQLite");
  });

  it("includes the last tool result when provided", () => {
    const out = buildMidConversationReminder({
      summary: "in progress",
      goal: "do the thing",
      lastResult: "42 matches found",
    });
    expect(out).toContain("Last tool result: 42 matches found");
  });

  it("includes the last error when provided", () => {
    const out = buildMidConversationReminder({
      summary: "in progress",
      goal: "do the thing",
      lastError: "ECONNRESET after 5s",
    });
    expect(out).toContain("Last error: ECONNRESET after 5s");
  });

  it("omits last-result / last-error blocks when not provided", () => {
    const out = buildMidConversationReminder({
      summary: "in progress",
      goal: "do the thing",
    });
    expect(out).not.toContain("Last tool result:");
    expect(out).not.toContain("Last error:");
  });

  it("ends with the next-best-action instruction", () => {
    const out = buildMidConversationReminder({
      summary: "in progress",
      goal: "do the thing",
    });
    expect(out.trim().endsWith(
      "Think step-by-step and take the next best action to complete the task.",
    )).toBe(true);
  });

  it("truncates fields that exceed the cap", () => {
    const huge = "z".repeat(5_000);
    const out = buildMidConversationReminder({
      summary: huge,
      goal: huge,
      lastResult: huge,
      lastError: huge,
    });
    expect(out).toContain("…(truncated for brevity)");
    // The full result is NOT present anywhere.
    expect(out).not.toContain("z".repeat(2_000));
  });
});

// ---------------------------------------------------------------------------
// 4. Integration with buildSystemPrompt — base is FIRST
// ---------------------------------------------------------------------------

describe("buildSystemPrompt — FeralAgent base layer", () => {
  it("includes the FeralAgent base content in the system prompt", () => {
    const prompt = buildSystemPrompt(fakeRegistry() as ToolRegistryType);
    expect(prompt).toContain("You are FeralAgent");
    expect(prompt).toContain("Task Completion First");
  });

  it("places the FeralAgent base as the FIRST block — above SOUL", () => {
    const prompt = buildSystemPrompt(
      fakeRegistry() as ToolRegistryType,
      sampleSoul,
    );
    const baseIdx = prompt.indexOf("FeralAgent base (highest priority — always on)");
    const soulIdx = prompt.indexOf("# Custom Soul");
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(soulIdx).toBeGreaterThan(baseIdx);
  });

  it("places the FeralAgent base as the FIRST block — above the USER block", () => {
    const prompt = buildSystemPrompt(
      fakeRegistry() as ToolRegistryType,
      sampleSoul,
      sampleUser,
    );
    const baseIdx = prompt.indexOf("FeralAgent base (highest priority — always on)");
    const userIdx = prompt.indexOf("Darius");
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(baseIdx);
  });

  it("places the FeralAgent base above the tool-call mechanics", () => {
    const prompt = buildSystemPrompt(fakeRegistry() as ToolRegistryType);
    const baseIdx = prompt.indexOf("FeralAgent base (highest priority — always on)");
    const toolsIdx = prompt.indexOf("## Available tools");
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(toolsIdx).toBeGreaterThan(baseIdx);
  });

  it("is present even when no SOUL is provided (backwards-compatible path)", () => {
    const prompt = buildSystemPrompt(fakeRegistry() as ToolRegistryType);
    expect(prompt).toContain("You are FeralAgent");
  });

  it("is present alongside SOUL — SOUL does not replace the base", () => {
    const prompt = buildSystemPrompt(
      fakeRegistry() as ToolRegistryType,
      sampleSoul,
    );
    expect(prompt).toContain("You are FeralAgent");
    expect(prompt).toContain("# Custom Soul");
  });

  it("marks SOUL as a user-customizable layer that refines (not overrides) the base", () => {
    const prompt = buildSystemPrompt(
      fakeRegistry() as ToolRegistryType,
      sampleSoul,
    );
    expect(prompt).toContain("user-customizable layer");
    // Defensive: the old "highest priority" framing for SOUL is gone, so a
    // user reading the prompt can't be misled into thinking SOUL outranks
    // the universal reliability contract.
    expect(prompt).not.toContain("SOUL.md — highest priority");
  });

  it("includes the legacy opener ONLY when no SOUL is provided", () => {
    const withSoul = buildSystemPrompt(
      fakeRegistry() as ToolRegistryType,
      sampleSoul,
    );
    const withoutSoul = buildSystemPrompt(fakeRegistry() as ToolRegistryType);
    expect(withSoul).not.toContain("You are Feral, a proactive and helpful AI assistant");
    expect(withoutSoul).toContain("You are Feral, a proactive and helpful AI assistant");
  });
});

// ---------------------------------------------------------------------------
// 5. Integration with AgentLoop — continuation appended after every tool result
// ---------------------------------------------------------------------------

type MockStep = { url: RegExp; status: number; body: unknown };

function installSequencedFetch(steps: MockStep[]): {
  restore: () => void;
  remaining: () => number;
  callPayloads: () => unknown[];
} {
  const original = globalThis.fetch;
  const callPayloads: unknown[] = [];
  let idx = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.body && typeof init.body === "string") {
      try { callPayloads.push(JSON.parse(init.body)); } catch { callPayloads.push(init.body); }
    } else {
      callPayloads.push(null);
    }
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const step = steps[idx];
    if (!step) throw new Error(`unexpected fetch call #${idx + 1} to ${url}`);
    if (!step.url.test(url)) {
      throw new Error(`fetch #${idx + 1}: expected ${step.url} but got ${url}`);
    }
    idx++;
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return {
    restore: () => { globalThis.fetch = original; },
    remaining: () => steps.length - idx,
    callPayloads: () => callPayloads,
  };
}

function toolBlock(name: string, args: Record<string, unknown>): string {
  return "```tool\n" + JSON.stringify({ name, args }) + "\n```";
}

function ollamaOk(content: string, promptTokens = 10, evalTokens = 5) {
  return {
    message: { content },
    prompt_eval_count: promptTokens,
    eval_count: evalTokens,
  };
}

let restoreFetch: (() => void) | null = null;
afterEach(() => { restoreFetch?.(); restoreFetch = null; });

describe("AgentLoop — tool-result continuation prompt", () => {
  it("appends a 'Continue towards completing the original goal' user message after a tool result", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "feral-cont-"));
    writeFileSync(join(workspace, "notes.txt"), "hello world");

    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const egress = new EgressProxy(audit.logger);
    const router = new InferenceRouter(
      {
        primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
        tokenBudget: BUDGET,
      },
      audit.logger,
      db.raw,
    );
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
    const registry = new ToolRegistry(egress, audit);
    registry.register(createReadFileTool([workspace]));
    const agent = new AgentLoop(router, registry, episodic, {}, recall);

    // Sequence:
    //   1. LLM → read_file tool call
    //   2. LLM → final answer (sees the continuation nudge on this call)
    const mock = installSequencedFetch([
      {
        url: /localhost:11434/,
        status: 200,
        body: ollamaOk(toolBlock("read_file", { path: join(workspace, "notes.txt") })),
      },
      {
        url: /localhost:11434/,
        status: 200,
        body: ollamaOk("The file says: hello world"),
      },
    ]);
    restoreFetch = mock.restore;

    const events: OutboundEvent[] = [];
    await agent.handle("sess-cont-1", "read the notes", "msg-1", (e) => events.push(e));

    // The second LLM call (after the tool result) must have received the
    // continuation prompt as a user-role message in its messages array.
    const payloads = mock.callPayloads();
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    const secondCall = payloads[1] as { messages?: Array<{ role: string; content: string }> };
    const continuationMsg = secondCall.messages?.find(
      (m) => m.role === "user" && m.content.includes("Continue towards completing the original goal"),
    );
    expect(continuationMsg).toBeDefined();
    // The continuation should reference the actual tool result content.
    expect(continuationMsg?.content).toContain("hello world");

    db.close();
  });

  it("appends one continuation per tool call in multi-tool turns", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "feral-cont-"));
    writeFileSync(join(workspace, "a.txt"), "alpha");
    writeFileSync(join(workspace, "b.txt"), "beta");

    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const egress = new EgressProxy(audit.logger);
    const router = new InferenceRouter(
      {
        primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
        tokenBudget: BUDGET,
      },
      audit.logger,
      db.raw,
    );
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
    const registry = new ToolRegistry(egress, audit);
    registry.register(createReadFileTool([workspace]));
    const agent = new AgentLoop(router, registry, episodic, {}, recall);

    // The model emits TWO read_file calls in one turn, then a final answer.
    const doubleToolTurn =
      toolBlock("read_file", { path: join(workspace, "a.txt") }) + "\n" +
      toolBlock("read_file", { path: join(workspace, "b.txt") });
    const mock = installSequencedFetch([
      { url: /localhost:11434/, status: 200, body: ollamaOk(doubleToolTurn) },
      { url: /localhost:11434/, status: 200, body: ollamaOk("Both files: alpha and beta.") },
    ]);
    restoreFetch = mock.restore;

    const events: OutboundEvent[] = [];
    await agent.handle("sess-cont-2", "read both", "msg-2", (e) => events.push(e));

    const payloads = mock.callPayloads();
    const secondCall = payloads[1] as { messages?: Array<{ role: string; content: string }> };
    const continuations = secondCall.messages?.filter(
      (m) => m.role === "user" && m.content.includes("Continue towards completing the original goal"),
    ) ?? [];
    // Two tool results → two continuation nudges. (A third would only appear
    // if the model fired a tool call on the second LLM round, which it did not.)
    expect(continuations.length).toBeGreaterThanOrEqual(2);
    // Each continuation should reference one of the actual tool results.
    const joined = continuations.map((c) => c.content).join("\n");
    expect(joined).toContain("alpha");
    expect(joined).toContain("beta");

    db.close();
  });
});
