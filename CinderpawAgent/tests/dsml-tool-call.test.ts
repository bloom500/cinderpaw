/**
 * DeepSeek's DSML tool-call framing must execute, not reach the person.
 *
 * Observed live in the Cinderpaw app (2026-08-29, DeepSeek v4 Flash via
 * OpenRouter) on a plain web-search request. The model emitted Anthropic-style
 * invoke XML, but fenced every tag with U+FF5C FULLWIDTH VERTICAL LINE:
 *
 *     <｜DSML｜tool_calls><｜DSML｜invoke name="web_search">
 *       <｜DSML｜parameter name="query" string="true">…</｜DSML｜parameter>
 *     </｜DSML｜invoke></｜DSML｜tool_calls>
 *
 * `parseResponse`'s namespace tolerance is `[A-Za-z_][\w.-]*:` — an ASCII name
 * and a colon — so none of it matched: no tool ran, and the user was handed the
 * raw markup as the answer to their question.
 *
 * Two shapes are pinned here because each failed for its own reason:
 *   1. the fullwidth fence, which hid the invoke structure entirely; and
 *   2. `<parameter name="q" string="true">`, whose second attribute broke the
 *      argument matcher. That one is the nastier failure — the call parses,
 *      the arguments do not, and the tool runs on an empty argument set.
 */
import { describe, it, expect } from "bun:test";
import { parseResponse } from "../src/core/agent-loop.ts";

const DSML_REAL =
  '<｜DSML｜tool_calls> <｜DSML｜invoke name="product_info">\n\n</｜DSML｜invoke> </｜DSML｜tool_calls>' +
  '<｜DSML｜tool_calls> <｜DSML｜invoke name="web_search"> ' +
  '<｜DSML｜parameter name="query" string="true">tau2-bench "MCP" server agent evaluation</｜DSML｜parameter> ' +
  "</｜DSML｜invoke> </｜DSML｜tool_calls>";

describe("DSML tool-call framing", () => {
  it("executes the calls instead of delivering them as text", () => {
    const parsed = parseResponse(DSML_REAL, ["product_info", "web_search"]);

    expect(parsed.toolCalls.map((c) => c.name)).toEqual(["product_info", "web_search"]);
    expect(parsed.malformedToolCall).toBe(false);
  });

  it("keeps the parameter value — a call with empty args is worse than no call", () => {
    const parsed = parseResponse(DSML_REAL, ["product_info", "web_search"]);
    const search = parsed.toolCalls.find((c) => c.name === "web_search");

    expect(search?.args).toEqual({
      query: 'tau2-bench "MCP" server agent evaluation',
    });
  });

  it("leaves no DSML markup in what the person reads", () => {
    const parsed = parseResponse(DSML_REAL, ["product_info", "web_search"]);

    expect(parsed.text).not.toContain("DSML");
    expect(parsed.text).not.toContain("invoke");
    expect(parsed.text).not.toContain("tool_calls");
  });

  /**
   * Second live sample, same session. A different shape: FOUR invokes inside
   * ONE wrapper, where the first sample had two invokes in two wrappers. It is
   * pinned separately because `parseInvokeXml`'s opener-terminated match (the
   * tolerance for a missing closer) is exactly the code that could let one call
   * swallow its siblings — a turn that asked for four searches running one.
   */
  it("reads every call when several share one wrapper", () => {
    const four =
      '<｜DSML｜tool_calls> ' +
      ['tau3-bench Sierra "tau³-bench" 2025 2026 benchmark release',
       "METR Perfect benchmark real-world terminal tasks 2025 open-ended agency",
       "Cybench METR cybersecurity agent benchmark runnable locally",
       "WindowsAgentArena Microsoft Windows agent benchmark 2025 status"]
        .map(
          (q) =>
            '<｜DSML｜invoke name="web_search"> ' +
            `<｜DSML｜parameter name="query" string="true">${q}</｜DSML｜parameter> ` +
            "</｜DSML｜invoke> ",
        )
        .join("") +
      "</｜DSML｜tool_calls>";

    const parsed = parseResponse(four, ["web_search"]);

    expect(parsed.toolCalls).toHaveLength(4);
    expect(parsed.toolCalls.map((c) => (c.args as { query: string }).query)).toEqual([
      'tau3-bench Sierra "tau³-bench" 2025 2026 benchmark release',
      "METR Perfect benchmark real-world terminal tasks 2025 open-ended agency",
      "Cybench METR cybersecurity agent benchmark runnable locally",
      "WindowsAgentArena Microsoft Windows agent benchmark 2025 status",
    ]);
    expect(parsed.text).toBe("");
  });

  it("still reads the plain Anthropic shape it always did", () => {
    const parsed = parseResponse(
      '<invoke name="web_search"><parameter name="query">hello</parameter></invoke>',
      ["web_search"],
    );

    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]?.args).toEqual({ query: "hello" });
  });
});
