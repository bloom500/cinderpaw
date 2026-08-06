import { describe, it, expect } from "bun:test";
import { stripThinking, summaryText } from "../src/core/agent-loop.ts";

describe("summaryText — what gets stored as a compaction summary", () => {
  it("keeps the summary and drops the reasoning", () => {
    // Measured: this was the only completion in the loop never stripped, and it
    // is the one re-sent for the rest of the session. A real stored summary
    // began `<think>The user wants me to summarize…` and was cut off before the
    // facts section, so the agent re-read 24 files it had already read.
    expect(summaryText("<think>let me see</think>### Established facts\n- cache.ts = 88 lines"))
      .toBe("### Established facts\n- cache.ts = 88 lines");
  });

  it("truncated mid-thought keeps the thinking rather than storing nothing", () => {
    // stripThinking alone returns "" here, and an empty summary throws away the
    // whole compacted region. The deliberation listed the facts — keep it.
    const out = summaryText("<think>binder.ts is 189 lines, cache.ts is 88 lines");
    expect(out).toContain("189");
    expect(out).not.toContain("<think>");
  });
});

describe("stripThinking", () => {
  it("plain answer is unchanged", () => {
    expect(stripThinking("Just an answer")).toBe("Just an answer");
  });

  it("bare unclosed <think> → empty (degraded model that only reasons)", () => {
    expect(stripThinking("<think>")).toBe("");
  });

  it("unclosed <think> with reasoning but no answer → empty", () => {
    expect(stripThinking("<think>let me reason about this")).toBe("");
  });

  it("paired <think>…</think> + answer → answer only", () => {
    expect(stripThinking("<think>reasoning here</think>Hello!")).toBe("Hello!");
  });

  it("<thinking> variant + trailing whitespace trimmed", () => {
    expect(stripThinking("<thinking>x</thinking>\n\nHi")).toBe("Hi");
  });

  it("multiple thinking blocks are all removed", () => {
    expect(stripThinking("<think>a</think>Part1<think>b</think>Part2")).toBe(
      "Part1Part2",
    );
  });

  it("Gemma <|channel>thought … <|channel>response → answer only", () => {
    expect(
      stripThinking("<|channel>thought planning the reply<|channel>response The answer"),
    ).toBe("The answer");
  });

  it("orphan closing tag is stripped", () => {
    expect(stripThinking("</think>answer")).toBe("answer");
  });

  // Regression: MiniMax-M2 / DeepSeek-R1-style chat templates bake the opening
  // <think> into the prompt, so the completion arrives as
  // "reasoning…</think>answer" with no opening tag. Everything before the
  // orphan close is reasoning and must never reach the chat.
  it("reasoning before orphan </think> is dropped (template bakes open tag into prompt)", () => {
    expect(stripThinking("Let me reason about this.\nDraft: …</think>Hello!")).toBe("Hello!");
  });

  it("orphan close followed by a later dangling open → only the answer survives", () => {
    expect(stripThinking("reasoning</think>answer<think>more reasoning")).toBe("answer");
  });
});
