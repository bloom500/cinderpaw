/**
 * Faza 4 Slice 2 — Dataset Builder v1: pairing, filters, redaction, hash.
 */

import { describe, expect, test } from "bun:test";
import {
  buildInstructionPairs,
  type EpisodicRow,
} from "../src/rsi/l2-adapt/dataset-builder.ts";

function row(sessionId: string, timestamp: number, role: string, content: string): EpisodicRow {
  return { sessionId, timestamp, role, content };
}

describe("buildInstructionPairs", () => {
  test("pairs consecutive user→assistant turns within a session", () => {
    const rows = [
      row("s1", 1, "user", "What is the capital of France?"),
      row("s1", 2, "assistant", "The capital of France is Paris."),
    ];
    const { pairs, hash } = buildInstructionPairs(rows);
    expect(pairs).toEqual([
      { instruction: "What is the capital of France?", response: "The capital of France is Paris." },
    ]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("groups by session and orders by timestamp regardless of input order", () => {
    const rows = [
      row("s2", 2, "assistant", "Second answer here."),
      row("s1", 2, "assistant", "First answer here now."),
      row("s1", 1, "user", "First question is this?"),
      row("s2", 1, "user", "Second question is that?"),
    ];
    const { pairs } = buildInstructionPairs(rows);
    expect(pairs).toHaveLength(2);
    const instructions = pairs.map((p) => p.instruction).sort();
    expect(instructions).toEqual(["First question is this?", "Second question is that?"]);
  });

  test("extra user turns collapse to the last question the model answered", () => {
    const rows = [
      row("s1", 1, "user", "ignore this earlier one"),
      row("s1", 2, "user", "this is the real question here"),
      row("s1", 3, "assistant", "here is the real answer now"),
    ];
    const { pairs } = buildInstructionPairs(rows);
    expect(pairs).toEqual([
      { instruction: "this is the real question here", response: "here is the real answer now" },
    ]);
  });

  test("ignores assistant turns with no preceding user", () => {
    const rows = [
      row("s1", 1, "assistant", "unsolicited greeting message here"),
      row("s1", 2, "user", "an actual question that is long enough"),
      row("s1", 3, "assistant", "an actual answer that is long enough"),
    ];
    const { pairs } = buildInstructionPairs(rows);
    expect(pairs).toHaveLength(1);
  });

  test("length filters drop too-short and too-long pairs", () => {
    const rows = [
      row("s1", 1, "user", "hi"), // too short (< 8)
      row("s1", 2, "assistant", "this answer is fine and long"),
      row("s1", 3, "user", "a question long enough to keep"),
      row("s1", 4, "assistant", "x".repeat(9000)), // too long
    ];
    const { pairs, dropped } = buildInstructionPairs(rows, { maxChars: 8000 });
    expect(pairs).toHaveLength(0);
    expect(dropped.tooShort).toBe(1);
    expect(dropped.tooLong).toBe(1);
  });

  test("exact duplicates collapse", () => {
    const rows = [
      row("s1", 1, "user", "the same question asked twice"),
      row("s1", 2, "assistant", "the same answer given twice"),
      row("s2", 1, "user", "The Same Question Asked Twice"), // case/space only diff
      row("s2", 2, "assistant", "the same answer given twice"),
    ];
    const { pairs, dropped } = buildInstructionPairs(rows);
    expect(pairs).toHaveLength(1);
    expect(dropped.duplicate).toBe(1);
  });

  test("redacts PII and strips private blocks from training data", () => {
    const rows = [
      row("s1", 1, "user", "email me at alice@example.com about the plan"),
      row("s1", 2, "assistant", "sure <private>secret note</private> here you go now"),
    ];
    const { pairs } = buildInstructionPairs(rows);
    expect(pairs[0]!.instruction).toContain("[REDACTED:email]");
    expect(pairs[0]!.instruction).not.toContain("alice@example.com");
    expect(pairs[0]!.response).not.toContain("secret note");
  });

  test("hash is stable for the same pairs and changes with content", () => {
    const a = buildInstructionPairs([
      row("s1", 1, "user", "a stable question here"),
      row("s1", 2, "assistant", "a stable answer here"),
    ]);
    const b = buildInstructionPairs([
      row("s1", 1, "user", "a stable question here"),
      row("s1", 2, "assistant", "a stable answer here"),
    ]);
    const c = buildInstructionPairs([
      row("s1", 1, "user", "a different question here"),
      row("s1", 2, "assistant", "a different answer here"),
    ]);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });
});
