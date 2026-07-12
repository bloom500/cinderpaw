/**
 * Stream holdback (2026-07-11): tool-call-shaped output must never reach the
 * live chunk stream — the observed failure was MiniMax M3 emitting
 * `<tool_call>{"invoke name="ask_user"">]<]minimax[>[…` garbage that streamed
 * raw into the chat, followed by a malformed-retry that streamed a duplicate
 * answer on top.
 */
import { describe, expect, test } from "bun:test";
import { createStreamHoldback, parseResponse } from "../src/core/agent-loop";

function run(tokens: string[], wasProse: boolean): string {
  let out = "";
  const hold = createStreamHoldback((t) => (out += t));
  for (const t of tokens) hold.push(t);
  hold.resolve(wasProse);
  return out;
}

describe("createStreamHoldback", () => {
  test("plain prose streams through untouched", () => {
    expect(run(["Hello ", "world", "!"], true)).toBe("Hello world!");
  });

  test("holds from <tool_call> onward and drops it for a parsed call", () => {
    const out = run(
      ["Sure, one sec.\n", "<tool_call>", '{"name":"list_tools","args":{}}', "</tool_call>"],
      false,
    );
    expect(out).toBe("Sure, one sec.\n");
  });

  test("opener split across token boundaries is still caught", () => {
    const out = run(["prose <tool_", "call>", '{"name":"x"}'], false);
    expect(out).toBe("prose ");
  });

  test("MiniMax garbage tool call never reaches the stream", () => {
    const garbage =
      '<tool_call>\n{"invoke name="ask_user"">]<]minimax[>[<questions>]<]minimax[>[</tool_call>';
    const out = run(["Am verificat.\n", garbage], false);
    expect(out).toBe("Am verificat.\n");
    // And the parser flags it malformed so the loop retries.
    const parsed = parseResponse("Am verificat.\n" + garbage);
    expect(parsed.toolCalls.length).toBe(0);
    expect(parsed.malformedToolCall).toBe(true);
  });

  test("false alarm (prose containing {\"name) is flushed on resolve", () => {
    const out = run(['config example: {"name', '": "demo"} rest'], true);
    expect(out).toBe('config example: {"name": "demo"} rest');
  });

  test("held garbage is dropped, resolve resets for the next turn", () => {
    let out = "";
    const hold = createStreamHoldback((t) => (out += t));
    hold.push("answer <tool_call>junk");
    hold.resolve(false);
    hold.push(" more prose");
    hold.resolve(true);
    expect(out).toBe("answer  more prose");
  });
});
