import { describe, it, expect } from "bun:test";
import { stripThinking } from "../src/core/agent-loop.ts";

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
});
