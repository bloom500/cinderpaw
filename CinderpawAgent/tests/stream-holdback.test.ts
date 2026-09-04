/**
 * Stream holdback (2026-07-11): tool-call-shaped output must never reach the
 * live chunk stream — the observed failure was MiniMax M3 emitting
 * `<tool_call>{"invoke name="ask_user"">]<]minimax[>[…` garbage that streamed
 * raw into the chat, followed by a malformed-retry that streamed a duplicate
 * answer on top.
 */
import { describe, expect, test } from "bun:test";
import { BARE_CALL_KEYS, createStreamHoldback, parseResponse } from "../src/core/agent-loop";

/**
 * `visible` is what the parser says the person should see. `true` is shorthand
 * for "all of it was prose", `false` for "only what had already streamed" —
 * the two cases the old boolean `resolve` covered. Pass a string for the case
 * it could not express: a turn that is part prose, part tool call.
 */
function run(tokens: string[], visible: string | boolean): string {
  let out = "";
  const hold = createStreamHoldback((t) => (out += t));
  for (const t of tokens) hold.push(t);
  hold.settle(typeof visible === "string" ? visible : visible ? tokens.join("") : out);
  return out;
}

const BR = String.fromCharCode(10);

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

  // Walk-away bench, 2026-07-25: 4 of the 4 non-infra failures ended here.
  // MiniMax dropped the <tool_call> wrapper entirely and emitted its native
  // XML framing naked, so nothing flagged it and the loop terminated with the
  // task half-done (a.mjs renamed, b.mjs never touched).
  test.each([
    [
      "write-cli#2 — shell_exec argv, no wrapper",
      "Let me use create_scripts instead.\n\n]<]minimax[>[<argv>]<]minimax[>[<item>cmd]<]minimax[>[</item>]<]minimax[>[</argv>]<]minimax[>[",
    ],
    [
      "multi-file-refactor#1 — edit_file, cut off mid-args",
      "export function greetB(n) { return GREETING; }]<]minimax[>[</old_string>]<]minimax[>[<new_string>import { SALUTATION } from './a.mjs';]<]minimax[>[</new_string>]<]minimax[>[",
    ],
    ["multi-file-refactor#2 — bare sentinel only", "]<]minimax[>["],
    [
      "fix-failing-test#2 — orphan closer, opener lost",
      '07-25T11-17-34-476Z\\\\fix-failing-test#2"}} </tool_call>',
    ],
  ])("naked MiniMax tool-call debris is malformed, not prose: %s", (_name, garbage) => {
    const parsed = parseResponse(garbage);
    expect(parsed.toolCalls.length).toBe(0);
    expect(parsed.malformedToolCall).toBe(true);
    expect(parsed.text).not.toContain("]<]minimax[>[");
  });

  test("naked MiniMax debris never reaches the stream", () => {
    const out = run(["Let me edit b.mjs.\n", "]<]minimax[>[<new_string>x]<]minimax[>["], false);
    expect(out).toBe("Let me edit b.mjs.\n");
  });

  // Walk-away bench, 2026-07-25 run 2: leads-to-crm. The model POSTed three
  // leads in one turn; one block parsed, two did not. The two were dropped
  // silently and the turn reported success, so the model told the user "all
  // three POSTs returned 201" while the CRM held one. Partial execution must
  // be visible or the follow-up retry duplicates whatever DID land.
  test("a mixed batch reports the calls that were dropped", () => {
    const raw =
      '<tool_call>{"name":"http_request","args":{"method":"POST","url":"/leads"}}</tool_call>' +
      '<tool_call>{"name":"http_request","args":{"method":"POST",,,}}</tool_call>' +
      '<tool_call>{"name"=http_request>broken</tool_call>';
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls.length).toBe(1);
    expect(parsed.droppedToolCalls).toBe(2);
    // The dropped blocks are scrubbed, never shown as prose.
    expect(parsed.text).not.toContain("http_request");
  });

  test("an all-good batch reports nothing dropped", () => {
    const raw =
      '<tool_call>{"name":"read_file","args":{"path":"a"}}</tool_call>' +
      '<tool_call>{"name":"read_file","args":{"path":"b"}}</tool_call>';
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls.length).toBe(2);
    expect(parsed.droppedToolCalls).toBe(0);
  });

  // n=9 run, 2026-07-25: asking the model for JSON did not work. It re-emitted
  // the same XML every retry and ads-campaign-triage finished having changed
  // nothing, 3 of 9 times. These are the literal completions from that run.
  test("MiniMax invoke-XML executes instead of being rejected", () => {
    const raw =
      'Let me pause the losing one.\n\n<invoke name="http_request">]<]minimax[>[<method>POST' +
      "]<]minimax[>[</method>]<]minimax[>[<url>http://127.0.0.1:18924/campaigns/summer_sale/pause" +
      "]<]minimax[>[</url>]<]minimax[>[</invoke>";
    const parsed = parseResponse(raw);
    expect(parsed.malformedToolCall).toBe(false);
    expect(parsed.toolCalls.length).toBe(1);
    expect(parsed.toolCalls[0]?.name).toBe("http_request");
    expect(parsed.toolCalls[0]?.args).toEqual({
      method: "POST",
      url: "http://127.0.0.1:18924/campaigns/summer_sale/pause",
    });
    expect(parsed.text).toBe("Let me pause the losing one.");
  });

  test("invoke-XML <item> children become an array", () => {
    const parsed = parseResponse(
      '<invoke name="shell_exec"><argv><item>cmd</item><item>/c</item>' +
        "<item>node --version</item></argv></invoke>",
    );
    expect(parsed.toolCalls[0]?.args).toEqual({ argv: ["cmd", "/c", "node --version"] });
  });

  test("invoke-XML JSON-valued arg is parsed, not stringified", () => {
    const parsed = parseResponse(
      '<invoke name="http_request"><json>{"email":"a@b.co","name":"A"}</json></invoke>',
    );
    expect(parsed.toolCalls[0]?.args).toEqual({ json: { email: "a@b.co", name: "A" } });
  });

  test("parallel invoke-XML calls all survive", () => {
    const parsed = parseResponse(
      '<invoke name="http_request"><url>/a</url></invoke>\n' +
        '<invoke name="http_request"><url>/b</url></invoke>',
    );
    expect(parsed.toolCalls.map((c) => (c.args as { url: string }).url)).toEqual(["/a", "/b"]);
  });

  // Vendored OpenClaw scanner (MIT) — shapes our own passes cannot read.
  // The allowlist is what makes running it safe, so it is tested as hard as
  // the formats: a name we do not have must NOT become a call.
  describe("vendored repair pass", () => {
    const allowed = ["read_file", "http_request"];

    test("<function=…><parameter=…> executes", () => {
      const parsed = parseResponse(
        "<function=read_file><parameter=path>/tmp/a.txt</parameter></function>",
        allowed,
      );
      expect(parsed.toolCalls.length).toBe(1);
      expect(parsed.toolCalls[0]?.name).toBe("read_file");
      expect(parsed.toolCalls[0]?.args).toEqual({ path: "/tmp/a.txt" });
    });

    test("[tool:name] + JSON executes", () => {
      const parsed = parseResponse('[tool:read_file]\n{"path":"/tmp/b.txt"}', allowed);
      expect(parsed.toolCalls.length).toBe(1);
      expect(parsed.toolCalls[0]?.args).toEqual({ path: "/tmp/b.txt" });
    });

    // Narrower than the exported constants suggest: the scanner requires the
    // literal " code" after the tool name. Pinned so an upgrade that changes
    // it is caught here rather than by a bench run.
    test("Harmony channel syntax executes", () => {
      const parsed = parseResponse(
        '<|channel|>commentary to=read_file code<|message|>{"path":"/tmp/c.txt"}<|call|>',
        allowed,
      );
      expect(parsed.toolCalls.length).toBe(1);
      expect(parsed.toolCalls[0]?.name).toBe("read_file");
    });

    test("Harmony's namespaced to=functions.NAME resolves", () => {
      const parsed = parseResponse(
        '<|channel|>commentary to=functions.read_file code<|message|>{"path":"/x"}<|call|>',
        allowed,
      );
      expect(parsed.toolCalls.length).toBe(1);
      expect(parsed.toolCalls[0]?.name).toBe("read_file");
    });

    test("the namespace rewrite does not bypass the allowlist", () => {
      const parsed = parseResponse(
        '<|channel|>commentary to=functions.exfiltrate code<|message|>{"a":1}<|call|>',
        allowed,
      );
      expect(parsed.toolCalls.length).toBe(0);
    });

    test("an unknown tool name is REJECTED, not invented", () => {
      const parsed = parseResponse(
        "<function=exfiltrate_secrets><parameter=to>evil.example</parameter></function>",
        allowed,
      );
      expect(parsed.toolCalls.length).toBe(0);
    });

    test("plain prose is never reinterpreted as a call", () => {
      const parsed = parseResponse("I read the file and it looks fine.", allowed);
      expect(parsed.toolCalls.length).toBe(0);
      expect(parsed.malformedToolCall).toBe(false);
      expect(parsed.text).toBe("I read the file and it looks fine.");
    });

    test("the canonical format still wins — the repair pass never sees it", () => {
      const parsed = parseResponse(
        '<tool_call>{"name":"http_request","args":{"url":"/a"}}</tool_call>',
        allowed,
      );
      expect(parsed.toolCalls.length).toBe(1);
      expect(parsed.toolCalls[0]?.args).toEqual({ url: "/a" });
    });
  });

  test("false alarm (prose containing {\"name) is flushed on resolve", () => {
    const out = run(['config example: {"name', '": "demo"} rest'], true);
    expect(out).toBe('config example: {"name": "demo"} rest');
  });

  test("held garbage is dropped, settle resets for the next turn", () => {
    let out = "";
    const hold = createStreamHoldback((t) => (out += t));
    hold.push("answer <tool_call>junk");
    hold.settle("answer ");
    hold.push(" more prose");
    hold.settle("answer  more prose");
    expect(out).toBe("answer  more prose");
  });

  /**
   * The reported bug: an answer cut off just before a tool call.
   *
   * Holding LATCHES on the first opener, and `{name` is an opener — a shape a
   * model writes in ordinary narration while explaining what it is about to
   * do. Everything from that brace to the end of the turn was held, and a turn
   * that ended in a real tool call then threw the whole buffer away. The prose
   * after the brace was never shown and never recovered.
   */
  test("prose that merely looks like a call survives a turn that ends in one", () => {
    const prose = "Setarea arata asa: {name: 'x'} — deci o schimb acum." + BR + BR;
    const call = '{"name":"write_file","arguments":{"path":"a.ts"}}';
    expect(run([prose, call], prose)).toBe(prose);
  });

  test("prose AFTER a tool call is shown too", () => {
    const before = "Verific fisierul." + BR;
    const call = '{"name":"read_file","arguments":{"path":"a.ts"}}';
    const after = BR + "Gata, l-am citit.";
    expect(run([before, call, after], before + after)).toBe(before + after);
  });

  test("a padded answer still flushes (parsed.text is trimmed, the stream is not)", () => {
    // The model opened with a blank line. A bare prefix comparison against the
    // parser's trimmed text fails here, and the tail would never be shown.
    const streamed = BR + BR + "Ma uit acum: {name: 'x'} si gata.";
    expect(run([streamed], streamed.trim())).toBe(streamed);
  });

  test("never re-sends what the stream already showed", () => {
    // The parser scrubbed something that had already gone out. Showing the
    // corrected text would duplicate the part they already read.
    let out = "";
    const hold = createStreamHoldback((t) => (out += t));
    hold.push("half a sentence");
    hold.settle("something else entirely");
    expect(out).toBe("half a sentence");
  });
});
