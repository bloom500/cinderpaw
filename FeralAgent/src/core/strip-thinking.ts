/**
 * Strip reasoning/thinking blocks from a model's final answer.
 *
 * Extracted from `agent-loop.ts` (which re-exports it, so every existing caller
 * is unchanged) because the RSI eval path needs it too, and importing the whole
 * agent loop into `rsi/infra/invoke-agent.ts` would drag the entire agent module
 * graph into every eval run.
 *
 * Local "thinking" models wrap chain-of-thought in tags the user must never see
 * in the answer area. The frontend splits these out of the *live* token stream,
 * but the agent loop's final answer (and the `done` event's content) is the
 * authoritative fallback used when streaming produced nothing — so it must be
 * stripped here too, or a degraded model that emits only `<think>` and stops
 * leaks the raw tag into the chat.
 *
 * Handles, in order:
 *   - paired  <think>…</think> / <thinking>…</thinking>   (any number)
 *   - Gemma   <|channel>thought … <|channel>response|end  (channel sections)
 *   - orphan close tag with no open (MiniMax / DeepSeek-R1 chat templates)
 *   - dangling <think> with no close → everything after it is reasoning, dropped
 *   - orphan stray tags left behind
 */
export function stripThinking(raw: string): string {
  let out = raw;

  // Paired blocks first (non-greedy, across newlines, case-insensitive).
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, "");
  out = out.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");

  // Gemma channel: keep only the text after a <|channel>response marker; drop
  // the thought section entirely. Then strip any remaining channel markers.
  const responseIdx = out.indexOf("<|channel>response");
  if (responseIdx !== -1) {
    out = out.slice(responseIdx + "<|channel>response".length);
  }
  out = out.replace(/<\|channel>thought[\s\S]*?(?=<\|channel>|$)/gi, "");
  out = out.replace(/<\|channel>[a-z]+/gi, "");

  // Orphan close tag with no open: MiniMax-M2 / DeepSeek-R1-style chat
  // templates bake the opening <think> into the prompt, so the completion
  // arrives as "reasoning…</think>answer". Everything before the first
  // remaining close tag (pairs were already removed above) is reasoning.
  const orphanClose = /<\/think(?:ing)?>/i.exec(out);
  if (orphanClose) {
    out = out.slice(orphanClose.index + orphanClose[0].length);
  }

  // Dangling open tag (model started reasoning and never closed / produced an
  // answer): drop the tag and everything after it.
  out = out.replace(/<think(?:ing)?>[\s\S]*$/gi, "");

  // Orphan stray tags.
  out = out.replace(/<\/?think(?:ing)?>/gi, "");

  return out.trim();
}
