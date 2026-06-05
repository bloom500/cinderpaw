import { describe, it, expect } from "bun:test";
import { isComplexTask } from "../src/core/agent-loop.ts";

describe("isComplexTask", () => {
  it("short simple question → false", () => {
    expect(isComplexTask("What is the capital of France?")).toBe(false);
  });

  it("contains 'research' keyword → true", () => {
    expect(isComplexTask("research the history of neural networks")).toBe(true);
  });

  it("contains 'analyze' → true", () => {
    expect(isComplexTask("analyze this dataset for trends")).toBe(true);
  });

  it("contains 'compare' → true", () => {
    expect(isComplexTask("compare GPT-4 and Claude on reasoning tasks")).toBe(true);
  });

  it("contains 'comprehensive' → true", () => {
    expect(isComplexTask("give me a comprehensive overview of RLHF")).toBe(true);
  });

  it("contains 'summarize' → true", () => {
    expect(isComplexTask("summarize the key findings from these papers")).toBe(true);
  });

  it("contains 'in-depth' → true", () => {
    expect(isComplexTask("I need an in-depth look at transformer architecture")).toBe(true);
  });

  it("long message (> 60 words) → true regardless of keywords", () => {
    const long = "word ".repeat(61).trim();
    expect(isComplexTask(long)).toBe(true);
  });

  it("exactly 60 words → false (threshold is > 60)", () => {
    const exactly60 = "word ".repeat(60).trim();
    expect(isComplexTask(exactly60)).toBe(false);
  });

  it("case-insensitive keyword match", () => {
    expect(isComplexTask("ANALYZE this report")).toBe(true);
    expect(isComplexTask("Research modern cryptography")).toBe(true);
  });

  it("'investigate' keyword → true", () => {
    expect(isComplexTask("investigate why the build is failing")).toBe(true);
  });

  it("'step-by-step' → true", () => {
    expect(isComplexTask("explain step-by-step how backprop works")).toBe(true);
  });
});
