/**
 * Long-horizon task fixes (2026-07-24). Four defects that only surface after a
 * few tool-heavy turns, each pinned by the smallest check that fails if the fix
 * regresses:
 *
 *   1. A tool call whose streamed `arguments` fragment was truncated by a
 *      `max_tokens` cutoff used to become an EMPTY args object, so `write_file`
 *      ran with no path and the loop saw a perfectly valid call — no retry.
 *   2. The local engine's "no model resident" 503 was stapled onto every cloud
 *      failure, burying the real cause behind "no model selected".
 *   3. The compaction summarizer read only the FIRST 6000 chars of everything
 *      it was compacting, dropping every path/command from the recent work.
 *   4. `{"tool_name": …}` — the third tool-call shape models emit — was not
 *      recognised and was rendered to the user as raw JSON.
 */
import { describe, expect, test } from "bun:test";
import { encodeToolCall } from "../src/egress/inference-providers";
import { isNoModelReady } from "../src/egress/inference-router";
import { headTail, parseResponse } from "../src/core/agent-loop";

describe("encodeToolCall — truncated arguments must not become empty args", () => {
  test("complete JSON string round-trips into a parseable call", () => {
    const parsed = parseResponse(
      encodeToolCall("write_file", '{"path":"a.txt","content":"hi"}'),
    );
    expect(parsed.toolCalls).toEqual([
      { name: "write_file", args: { path: "a.txt", content: "hi" } },
    ]);
    expect(parsed.malformedToolCall).toBe(false);
  });

  test("an already-decoded object round-trips too", () => {
    const parsed = parseResponse(encodeToolCall("read_file", { path: "b.txt" }));
    expect(parsed.toolCalls).toEqual([{ name: "read_file", args: { path: "b.txt" } }]);
  });

  test("empty arguments stay a valid zero-arg call", () => {
    const parsed = parseResponse(encodeToolCall("time_date", ""));
    expect(parsed.toolCalls).toEqual([{ name: "time_date", args: {} }]);
    expect(parsed.malformedToolCall).toBe(false);
  });

  test("a truncated fragment is flagged malformed, NOT executed with {}", () => {
    // What a max_tokens cutoff mid-write_file actually delivers.
    const parsed = parseResponse(
      encodeToolCall("write_file", '{"path":"src/app.ts","content":"export const'),
    );
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.malformedToolCall).toBe(true);
  });

  test("non-JSON garbage is flagged malformed", () => {
    const parsed = parseResponse(encodeToolCall("shell_exec", "argv=[git status]"));
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.malformedToolCall).toBe(true);
  });
});

describe("isNoModelReady — the fallback's excuse is not the user's error", () => {
  test("recognises the bundled engine's 503 body", () => {
    expect(
      isNoModelReady(
        Object.assign(
          new Error(
            'inference endpoint http://127.0.0.1:11435/v1/chat/completions returned 503: ' +
              '{"error":{"message":"no model selected — choose one in Models","type":"model_not_ready"}}',
          ),
          { status: 503 },
        ),
      ),
    ).toBe(true);
  });

  test("recognises the streaming path's bare message", () => {
    expect(isNoModelReady(new Error("no model loaded"))).toBe(true);
  });

  test("a real provider failure is NOT swallowed as a no-model excuse", () => {
    expect(
      isNoModelReady(
        Object.assign(new Error("returned 400: context length exceeded"), { status: 400 }),
      ),
    ).toBe(false);
    expect(isNoModelReady(new Error("fetch failed"))).toBe(false);
    expect(
      isNoModelReady(Object.assign(new Error("returned 503: upstream overloaded"), { status: 503 })),
    ).toBe(false);
  });
});

describe("headTail — the summarizer must see the recent work, not just the opening", () => {
  test("short text passes through untouched", () => {
    expect(headTail("abc", 100)).toBe("abc");
  });

  test("keeps BOTH ends and marks the elision", () => {
    const text = "START" + "x".repeat(5_000) + "END";
    const out = headTail(text, 500);
    expect(out.startsWith("START")).toBe(true);
    expect(out.endsWith("END")).toBe(true);
    expect(out).toContain("elided");
    expect(out.length).toBeLessThanOrEqual(500);
  });

  test("the tail is the larger share — it is what the next turn needs", () => {
    const text = "H".repeat(5_000) + "T".repeat(5_000);
    const out = headTail(text, 1_000);
    const tails = (out.match(/T/g) ?? []).length;
    const heads = (out.match(/H/g) ?? []).length;
    expect(tails).toBeGreaterThan(heads);
  });
});

describe("parseResponse — the {\"tool_name\"} call shape", () => {
  test("executes instead of leaking as raw JSON", () => {
    const parsed = parseResponse(
      'Let me check.\n{"tool_name": "read_file", "arguments": {"path": "x.ts"}}',
    );
    expect(parsed.toolCalls).toEqual([{ name: "read_file", args: { path: "x.ts" } }]);
    expect(parsed.text).not.toContain("tool_name");
  });

  test("still recognised inside a ```tool fence", () => {
    const parsed = parseResponse(
      '```tool\n{"tool_name": "list_tools", "arguments": {}}\n```',
    );
    expect(parsed.toolCalls).toEqual([{ name: "list_tools", args: {} }]);
  });

  test("prose JSON that merely mentions a tool is untouched", () => {
    const raw = 'The config is {"port": 8080, "tool": "vite"} in vite.config.ts.';
    const parsed = parseResponse(raw);
    expect(parsed.toolCalls).toHaveLength(0);
  });
});
