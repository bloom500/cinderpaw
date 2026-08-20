/**
 * Chat-surface formatting.
 *
 * The "it spits out a block of text" report had two mechanical causes: the old
 * chunker split fenced code blocks (leaving one message with an unclosed fence
 * and the next with none), and Discord cannot render markdown tables at all.
 */

import { describe, expect, test } from "bun:test";
import { formatForChat, chatStyleBrief, DISCORD_LIMIT } from "../src/transports/chat-format.ts";

/** Fences must balance in EVERY message, or Discord renders the rest as code. */
function fencesBalanced(message: string): boolean {
  return (message.match(/^\s*```/gm) ?? []).length % 2 === 0;
}

describe("formatForChat", () => {
  test("a short answer is one message, untouched", () => {
    expect(formatForChat("hello there")).toEqual(["hello there"]);
  });

  test("empty output never sends an empty message", () => {
    expect(formatForChat("   \n  ")).toEqual(["(no response)"]);
  });

  test("a code block spanning the limit is re-fenced in every part", () => {
    const code = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const parts = formatForChat(`Here you go:\n\n\`\`\`ts\n${code}\n\`\`\``);

    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(DISCORD_LIMIT);
      expect(fencesBalanced(p)).toBe(true);
    }
    // Every continuation keeps the language tag, so each renders as a code box.
    const codeParts = parts.filter((p) => p.includes("```"));
    expect(codeParts.length).toBeGreaterThan(1);
    for (const p of codeParts) expect(p).toContain("```ts");
    // Nothing was lost in the split.
    const rejoined = parts.join("\n").replace(/```ts?\n?/g, "").replace(/```/g, "");
    expect(rejoined).toContain("const line0 = 0;");
    expect(rejoined).toContain("const line399 = 399;");
  });

  test("an unterminated fence is closed instead of bleeding into the channel", () => {
    // What a reply truncated by the model's output cap looks like.
    const parts = formatForChat("Here:\n\n```py\nprint('cut off mid-bl");
    expect(parts).toHaveLength(1);
    expect(fencesBalanced(parts[0]!)).toBe(true);
    expect(parts[0]).toContain("print('cut off mid-bl");
  });

  test("a markdown table becomes an aligned monospace block", () => {
    const parts = formatForChat(
      ["Results:", "", "| Model | Score |", "|---|---|", "| MiniMax M3 | 91 |", "| Local 8B | 44 |"].join("\n"),
    );
    const all = parts.join("\n");
    // Discord has no table support, so it must not arrive as raw markdown.
    expect(all).toContain("```");
    expect(all).toContain("MiniMax M3");
    // Columns are padded to a common width — the whole point of the rewrite.
    expect(all).toContain("| MiniMax M3 | 91    |");
    expect(all).toContain("| Local 8B   | 44    |");
    // The separator row is not repeated as literal markdown dashes-and-pipes.
    expect(all).not.toContain("|---|---|");
  });

  test("prose around a table survives as prose", () => {
    const parts = formatForChat(
      ["Before.", "", "| a | b |", "|---|---|", "| 1 | 2 |", "", "After."].join("\n"),
    );
    const all = parts.join("\n\n");
    expect(all).toContain("Before.");
    expect(all).toContain("After.");
    expect(all.indexOf("Before.")).toBeLessThan(all.indexOf("After."));
  });

  test("long prose splits on paragraphs, not mid-sentence", () => {
    const para = (n: number) => `Paragraph ${n}. ` + "Words fill this out. ".repeat(20);
    const parts = formatForChat([1, 2, 3, 4, 5, 6].map(para).join("\n\n"));

    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(DISCORD_LIMIT);
    // No message begins mid-sentence: each starts at a paragraph boundary.
    for (const p of parts) expect(p.trimStart()).toStartWith("Paragraph ");
  });

  test("a bullet list is not torn apart item by item", () => {
    const list = Array.from({ length: 12 }, (_, i) => `- item ${i}`).join("\n");
    const parts = formatForChat(`Here:\n\n${list}`);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain("- item 0");
    expect(parts[0]).toContain("- item 11");
  });

  test("an unbroken run with no word boundary still respects the limit", () => {
    const parts = formatForChat("x".repeat(7_000));
    expect(parts.length).toBeGreaterThan(3);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(DISCORD_LIMIT);
    expect(parts.join("").length).toBe(7_000);
  });

  test("wider surfaces get fewer messages", () => {
    const text = "Paragraph. ".repeat(250);
    expect(formatForChat(text, 4096).length).toBeLessThan(formatForChat(text, 2000).length);
  });

  test("mixed answer: every message is within limit and independently renderable", () => {
    const text = [
      "# Report",
      "",
      "Short intro paragraph explaining the thing.",
      "",
      "| Col | Value |",
      "|---|---|",
      "| a | 1 |",
      "",
      "```bash",
      Array.from({ length: 120 }, (_, i) => `echo "line ${i}"`).join("\n"),
      "```",
      "",
      "- one",
      "- two",
      "",
      "Closing note.",
    ].join("\n");

    const parts = formatForChat(text);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(DISCORD_LIMIT);
      expect(fencesBalanced(p)).toBe(true);
      expect(p.trim()).not.toBe("");
    }
    const all = parts.join("\n");
    expect(all).toContain("# Report");
    expect(all).toContain("Closing note.");
    expect(all).toContain('echo "line 119"');
  });
});

describe("chatStyleBrief", () => {
  test("names the surface and forbids the things it cannot render", () => {
    const brief = chatStyleBrief("Discord");
    expect(brief).toContain("Discord");
    expect(brief).toContain("No markdown tables");
    expect(brief).toContain("fenced blocks");
  });
});
