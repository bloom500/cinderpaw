/**
 * Tool-call grammar (GBNF) for grammar-constrained decoding.
 *
 * The bundled llama.cpp engine can constrain sampling to a GBNF grammar so a
 * local model can only emit tokens the grammar allows. We use this to make
 * tool calls reliable: instead of hoping a 7B model produces valid JSON and
 * then patching every way it fails (`parseResponse`'s many fallback passes),
 * the grammar makes a malformed tool call physically impossible.
 *
 * We apply it *lazily*: the grammar stays dormant until the model emits one of
 * `TOOL_CALL_TRIGGERS` (the opening of a tool-call fence). Until then the model
 * writes prose freely — so a final natural-language answer is never
 * constrained. Once a trigger fires, the grammar forces the tool call that
 * follows to be a single valid `{"name": <tool>, "args": {…}}` object. Any
 * trailing text (the closing ``` fence) is unconstrained, so the model is
 * never painted into a corner where it cannot terminate.
 *
 * The text parser (`parseResponse`) stays in place as the fallback for cloud
 * providers and for models that never trip a trigger — grammar makes the local
 * path reliable without removing that safety net.
 */

/**
 * Strings that switch the lazy grammar on. These mirror the tool-call formats
 * the system prompt teaches and that `parseResponse` accepts, so a model that
 * opens any of them is immediately held to valid JSON.
 */
export const TOOL_CALL_TRIGGERS: readonly string[] = [
  "```tool",
  "```json",
  "<tool_call>",
];

/** Escape a string for use as a GBNF double-quoted literal. */
function gbnfLiteral(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build a GBNF grammar for a tool call: `{"name": <one of toolNames>, "args":
 * <json object>}` optionally followed by free trailing text (the closing
 * fence). When `toolNames` is non-empty the `name` field is restricted to the
 * exact set of registered tools, so the model cannot invent a tool that does
 * not exist. With no tools, the grammar degrades to any JSON string name.
 */
export function buildToolCallGrammar(toolNames: readonly string[]): string {
  const names = toolNames.filter((n) => n && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  const nameRule =
    names.length > 0
      ? names.map(gbnfLiteral).join(" | ")
      : "string";

  // A standard JSON value grammar, with the top-level `root` pinned to the
  // tool-call shape. `rest` absorbs any trailing output (closing fence /
  // whitespace) so generation can always reach an end-of-generation token.
  return [
    `root    ::= ws "{" ws "\\"name\\"" ws ":" ws name ws "," ws "\\"args\\"" ws ":" ws object ws "}" rest`,
    `name    ::= ${nameRule}`,
    // "Any char" is [^\x00] (anything but NUL — never emitted by a model).
    // The literal [^] form reads as an EMPTY negated class in llama.cpp's
    // GBNF parser, which its left-recursion check then rejects with
    // "unsupported grammar, left recursion detected" and the whole grammar
    // silently degrades to unconstrained sampling.
    `rest    ::= anychar*`,
    `anychar ::= [^\\x00]`,
    `object  ::= "{" ws ( member ( ws "," ws member )* )? ws "}"`,
    `member  ::= string ws ":" ws value`,
    `array   ::= "[" ws ( value ( ws "," ws value )* )? ws "]"`,
    `value   ::= string | number | object | array | "true" | "false" | "null"`,
    `string  ::= "\\"" ( [^"\\\\] | "\\\\" [^\\x00] )* "\\""`,
    `number  ::= "-"? ( "0" | [1-9] [0-9]* ) ( "." [0-9]+ )? ( [eE] [-+]? [0-9]+ )?`,
    `ws      ::= [ \\t\\n\\r]*`,
  ].join("\n");
}
