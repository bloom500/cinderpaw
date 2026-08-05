/**
 * Behaviour scenarios against a scripted model.
 *
 * Each scenario is named after the failure it prevents, and every one of them
 * is a failure this project actually shipped at least once: a stacked
 * tool-call block where only the first call ran; a token cutoff presented as a
 * finished answer; a malformed call delivered to the user as the reply; a
 * read-only promise the file tools did not keep.
 *
 * The unit tests check that functions are correct. These check that the AGENT
 * behaves, which is the thing users actually complain about and the thing no
 * amount of function-level coverage has ever caught on its own.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runScenario, toolCall } from "./parity/harness.ts";

describe("parity: baseline", () => {
  test("streaming_text — a plain answer comes back whole", async () => {
    const out = await runScenario({
      name: "streaming_text",
      category: "baseline",
      proves: "the simplest possible turn still works",
      prompt: "say hello",
      script: [{ content: "Hello — nothing to do here." }],
    });
    expect(out.answer).toContain("Hello");
    expect(out.completions).toBe(1);
  });
});

describe("parity: file tools", () => {
  test("read_file_roundtrip — the tool result reaches the next completion", async () => {
    const out = await runScenario({
      name: "read_roundtrip",
      category: "file-tools",
      proves: "a tool result the model never sees is a tool that did not run",
      prompt: "what is in a.txt?",
      script: [
        { content: toolCall("write_file", { path: "{{ws}}/a.txt", content: "parity-marker" }) },
        { content: toolCall("read_file", { path: "{{ws}}/a.txt" }) },
        { content: "It says: parity-marker" },
      ],
    });
    expect(out.answer).toContain("parity-marker");
    // The read's OUTPUT must appear in what was sent back to the model.
    expect(out.sent.join("\n")).toContain("parity-marker");
    expect(await readFile(join(out.workspace, "a.txt"), "utf8")).toBe("parity-marker");
  });

  test("multi_tool_turn — both calls in one message run, not just the first", async () => {
    // Shipped broken once: a stacked block executed call #1 and silently
    // dropped the rest, so half the work vanished with no error anywhere.
    const out = await runScenario({
      name: "multi_tool",
      category: "file-tools",
      proves: "a stacked tool_call block is not a one-call block",
      prompt: "write both files",
      script: [
        {
          content:
            toolCall("write_file", { path: "{{ws}}/one.txt", content: "alpha" }) +
            "\n" +
            toolCall("write_file", { path: "{{ws}}/two.txt", content: "beta" }),
        },
        { content: "Both written." },
      ],
    });
    expect(await readFile(join(out.workspace, "one.txt"), "utf8")).toBe("alpha");
    expect(await readFile(join(out.workspace, "two.txt"), "utf8")).toBe("beta");
  });
});

describe("parity: permissions", () => {
  test("write_denied_outside_root — refused, and the model is told why", async () => {
    const out = await runScenario({
      name: "write_denied",
      category: "permissions",
      proves: "a refusal the model cannot read is a silent failure",
      prompt: "write to the system directory",
      script: [
        { content: toolCall("write_file", { path: "/etc/feral-parity-probe", content: "x" }) },
        { content: "I could not write there." },
      ],
    });
    // The model must SEE the refusal — that is what lets it change course.
    expect(out.sent.join("\n").toLowerCase()).toMatch(/outside|denied|protected|not permitted/);
    expect(out.answer).toContain("could not write");
  });

  test("read_only_mode — the file tools keep the promise the mode makes", async () => {
    const out = await runScenario({
      name: "read_only",
      category: "permissions",
      proves: "a read-only mode that only stops the shell is a lie",
      prompt: "audit and fix",
      script: [
        { content: toolCall("write_file", { path: "{{ws}}/fix.txt", content: "changed" }) },
        { content: "Read-only mode — reporting instead of changing." },
      ],
      env: { FERAL_PERMISSION_MODE: "read_only" },
    });
    expect(out.sent.join("\n")).toContain("read-only");
    await expect(readFile(join(out.workspace, "fix.txt"), "utf8")).rejects.toThrow();
  });
});

describe("parity: resilience", () => {
  test("malformed_tool_call — retried, then never delivered as prose", async () => {
    const broken = '<tool_call>\n{"name="read_file","args":{"path":"a.txt"}}\n</tool_call>';
    const out = await runScenario({
      name: "malformed",
      category: "resilience",
      proves: "the user must never be handed the machine syntax the parser rejected",
      prompt: "read a.txt",
      script: [
        { content: broken },
        { content: broken },
        { content: broken },
        { content: broken },
        { content: broken },
      ],
    });
    expect(out.answer).not.toContain("<tool_call>");
    expect(out.answer).not.toContain('"name=');
    // It asked for a valid call rather than giving up on the first bad one.
    expect(out.sent.join("\n")).toContain("invalid JSON");
  });

  test("token_cutoff_continuation — a cut-off answer is finished, not truncated", async () => {
    // The "agent randomly stops writing mid-sentence" report.
    const out = await runScenario({
      name: "cutoff",
      category: "resilience",
      proves: "an answer cut by max_tokens is continued, and the user sees one whole reply",
      prompt: "explain the plan",
      script: [
        { content: "The plan has three parts. First, we", finishReason: "length" },
        { content: " read the config. Second, we patch it. Third, we verify." },
      ],
    });
    expect(out.answer).toContain("The plan has three parts");
    expect(out.answer).toContain("Third, we verify");
    expect(out.completions).toBeGreaterThan(1);
  });

  test("repeated_failure — the loop corrects the model instead of burning turns", async () => {
    const out = await runScenario({
      name: "repeat_fail",
      category: "resilience",
      proves: "the same failing call twice is a loop, and a loop must be interrupted",
      prompt: "read the missing file",
      script: [
        { content: toolCall("read_file", { path: "{{ws}}/missing.txt" }) },
        { content: toolCall("read_file", { path: "{{ws}}/missing.txt" }) },
        { content: toolCall("read_file", { path: "{{ws}}/missing.txt" }) },
        { content: "That file does not exist." },
      ],
    });
    expect(out.sent.join("\n")).toMatch(/failed twice|looping/i);
    expect(out.answer).toContain("does not exist");
  });
});
