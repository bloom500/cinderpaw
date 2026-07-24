/**
 * Stream holdback (2026-07-11): tool-call-shaped output must never reach the
 * live chunk stream — the observed failure was MiniMax M3 emitting
 * `<tool_call>{"invoke name="ask_user"">]<]minimax[>[…` garbage that streamed
 * raw into the chat, followed by a malformed-retry that streamed a duplicate
 * answer on top.
 */
import { describe, expect, test } from "bun:test";
import { BARE_CALL_KEYS, createStreamHoldback, parseResponse } from "../src/core/agent-loop";

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

  // A pretty-printing model emits `{ "name": … }` / `{\n  "name": … }`. Those
  // PARSE fine, so the call executed — but the literal opener list did not
  // match them, so the raw JSON streamed into the chat first.
  test("bare call with whitespace after the brace is held back", () => {
    expect(run(["Let me check.\n", '{ "name": "list_tools", "args": {} }'], false))
      .toBe("Let me check.\n");
    expect(run(["Let me check.\n", '{\n  "name": "list_tools",\n  "args": {}\n}'], false))
      .toBe("Let me check.\n");
  });

  test("bare call arriving one character at a time is held from the brace", () => {
    const tokens = 'ok {  "tool_name": "grep", "args": {} }'.split("");
    expect(run(tokens, false)).toBe("ok ");
  });

  /**
   * The holdback and `extractBareToolCalls` recognise the same shapes through
   * two different mechanisms (character scan vs regex). This asserts they
   * agree for every declared key — drift between them is exactly the bug
   * above, and a comment would not have caught it.
   */
  test("every bare-call key is both held back and parsed", () => {
    for (const key of BARE_CALL_KEYS) {
      const payload =
        key === "invoke"
          ? '{ "invoke": "list_tools", "args": {} }'
          : `{ "${key}": "list_tools", "args": {} }`;
      const streamed = run(["thinking...\n", payload], false);
      expect(streamed, `key ${key} leaked into the stream`).toBe("thinking...\n");
      expect(parseResponse(payload).text, `key ${key} left raw JSON in the text`)
        .not.toContain("list_tools");
    }
  });

  test("ordinary JSON in prose still streams (not every brace is a call)", () => {
    expect(run(['The config is { "port": 8080 }.'], true)).toBe('The config is { "port": 8080 }.');
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
