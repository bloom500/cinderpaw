/**
 * tool-grammar — GBNF builder for grammar-constrained tool calls.
 */

import { describe, expect, it } from "bun:test";
import { buildToolCallGrammar, TOOL_CALL_TRIGGERS } from "../src/core/tool-grammar.ts";

describe("buildToolCallGrammar", () => {
  it("pins the top-level shape to a name + args object", () => {
    const g = buildToolCallGrammar(["web_search", "read_file"]);
    expect(g).toContain("root");
    expect(g).toContain('\\"name\\"');
    expect(g).toContain('\\"args\\"');
    // object/string/number rules are present for valid JSON args.
    expect(g).toContain("object");
    expect(g).toContain("string");
    expect(g).toContain("number");
  });

  it("restricts the tool name to the registered set", () => {
    const g = buildToolCallGrammar(["web_search", "read_file"]);
    // Each tool name appears as a quoted GBNF literal in the `name` rule.
    expect(g).toContain('"web_search"');
    expect(g).toContain('"read_file"');
    // A tool that was not registered must not appear.
    expect(g).not.toContain('"delete_everything"');
  });

  it("falls back to a free string name when no tools are given", () => {
    const g = buildToolCallGrammar([]);
    expect(g).toContain("name    ::= string");
  });

  it("ignores tool names that are not valid identifiers", () => {
    // A name with a quote or space could break the grammar literal — drop it.
    const g = buildToolCallGrammar(["ok_tool", 'bad"name', "also bad"]);
    expect(g).toContain('"ok_tool"');
    expect(g).not.toContain("bad");
  });

  it("never emits the [^] empty negated class llama.cpp rejects", () => {
    // llama.cpp parses a literal `[^]` as an EMPTY negated class and its
    // left-recursion check then rejects the whole grammar ("unsupported
    // grammar, left recursion detected"), silently degrading to
    // unconstrained sampling. Any-char must be spelled [^\x00].
    const g = buildToolCallGrammar(["web_search"]);
    expect(g).not.toContain("[^]");
    expect(g).toContain("[^\\x00]");
  });

  it("exposes tool-call fence triggers for lazy enforcement", () => {
    expect(TOOL_CALL_TRIGGERS).toContain("```tool");
    expect(TOOL_CALL_TRIGGERS.length).toBeGreaterThan(0);
  });
});
