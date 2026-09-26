/**
 * The extractor reads the person, not the tools.
 *
 * It took the last six messages of the working transcript. In an agentic turn
 * those are tool calls and tool output, so after three tool calls the user's
 * own message was outside the window and facts "about the USER" were mined
 * from a directory listing. Its cadence counted assistant messages, which a
 * tool-calling turn adds one per call.
 */
import { describe, expect, it } from "bun:test";
import { MemoryExtractor, conversationForExtraction } from "../src/memory/extractor.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { openDatabase } from "../src/db.ts";
import type { ChatMessage, InferenceRouter } from "../src/types.ts";

const toolTurn = (said: string, calls: number, answer: string): ChatMessage[] => [
  { role: "user", content: said },
  ...Array.from({ length: calls }, (_, i): ChatMessage[] => [
    { role: "assistant", content: `<tool_call>{"name":"read_file","arguments":{"path":"f${i}"}}</tool_call>` },
    { role: "tool", name: "read_file", content: `contents of f${i}: lorem ipsum` },
  ]).flat(),
  { role: "assistant", content: answer },
];

describe("conversationForExtraction", () => {
  it("keeps each user message and the final answer, drops tool traffic and nudges", () => {
    const turns: ChatMessage[] = [
      ...toolTurn("I moved to Lisbon, update my config", 4, "Done, config updated."),
      { role: "user", content: "(system: your previous reply was empty.)" },
      { role: "assistant", content: "Anything else?" },
    ];
    expect(conversationForExtraction(turns)).toEqual([
      { role: "user", content: "I moved to Lisbon, update my config" },
      { role: "assistant", content: "Anything else?" },
    ]);
  });
});

describe("MemoryExtractor — an agentic turn", () => {
  it("sends the user's words to the model, not the tool output", async () => {
    const prompts: string[] = [];
    const router = {
      complete: async (req: { messages: ChatMessage[] }) => {
        prompts.push(req.messages.at(-1)!.content);
        return { content: "=== FACTS ===\nNONE\n=== OBSERVATION ===\nSKIP" };
      },
      evictSession: () => {},
    } as unknown as InferenceRouter;
    const db = openDatabase(":memory:");
    const extractor = new MemoryExtractor(router, new SemanticMemory(db.raw, () => {}));
    // One exchange with five tool calls: 12 messages, 6 assistant messages.
    extractor.extractAsync("s1", toolTurn("I moved to Lisbon, update my config", 5, "Done."));
    await extractor.drain(2000);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("I moved to Lisbon");
    expect(prompts[0]).not.toContain("lorem ipsum");
    db.close();
  });
});
