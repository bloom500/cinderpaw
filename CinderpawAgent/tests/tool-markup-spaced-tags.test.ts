/**
 * DeepSeek v4.1 Flash, 26 Sep: tool-call markup reached the chat as
 * `</ parameter>`. Two holes, both in parseResponse: a tag with a space after
 * the bracket was not recognised at all, and a closing tag left over after the
 * call had already run was handed to the person as part of the answer.
 */
import { expect, test } from "bun:test";
import { parseResponse } from "../src/core/agent-loop.ts";

const TOOLS = ["web_search"];

test("a stray closing tag after the answer is not part of the answer", () => {
  expect(parseResponse("Gata, am terminat.</parameter>", TOOLS).text).toBe("Gata, am terminat.");
  expect(parseResponse("Gata, am terminat. </ parameter>", TOOLS).text).toBe("Gata, am terminat.");
});

test("the call runs, and the framing's tail does not reach the chat", () => {
  const r = parseResponse('<tool_call>\n{"name":"web_search","args":{"query":"vreme"}}\n</ parameter>\n</ invoke>', TOOLS);
  expect(r.toolCalls.map((c) => c.name)).toEqual(["web_search"]);
  expect(r.text).toBe("");
});

test("spaced DeepSeek tags are read as a call, not shown as markup", () => {
  const dsml =
    'Caut acum.\n< ｜DSML｜tool_calls>\n< ｜DSML｜invoke name="web_search">\n' +
    '< ｜DSML｜parameter name="query" string="true">vreme</ ｜DSML｜parameter>\n</ ｜DSML｜invoke>\n</ ｜DSML｜tool_calls>';
  const r = parseResponse(dsml, TOOLS);
  expect(r.toolCalls).toHaveLength(1);
  expect(r.toolCalls[0]!.args).toEqual({ query: "vreme" });
  expect(r.text).toBe("Caut acum.");

  const plain = 'Caut acum.\n<invoke name="web_search">\n<parameter name="query">vreme</ parameter>\n</ invoke>';
  expect(parseResponse(plain, TOOLS).toolCalls).toHaveLength(1);
});

test("markup inside a code fence is left alone, and so is a comparison in prose", () => {
  const fenced = 'Asa arata:\n```xml\n<parameter name="q">x</parameter>\n```';
  expect(parseResponse(fenced, TOOLS).text).toContain("</parameter>");
  expect(parseResponse("Daca a < b, atunci b > a.", TOOLS).text).toBe("Daca a < b, atunci b > a.");
});
