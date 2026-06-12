export interface SplitResult {
  thinking: string | null;
  answer: string;
  thinkingComplete: boolean;
}

// Thinking block formats used by various local models:
//   <think>...</think>          — Qwen3, QwQ, DeepSeek-R1, most mainstream
//   <thinking>...</thinking>    — some fine-tunes
//   <|channel>thought...        — Gemma uncensored fine-tunes (closes on <|channel>response or <|channel>end)
const OPEN_TAGS: Array<{ open: string; close: string; openLen: number; closeLen: number }> = [
  { open: '<think>',         close: '</think>',         openLen: 7,  closeLen: 8  },
  { open: '<thinking>',      close: '</thinking>',      openLen: 10, closeLen: 11 },
  { open: '<|channel>thought', close: '<|channel>',    openLen: 17, closeLen: 10 },
];

/**
 * Heuristic: does the visible answer (after thinking is stripped) look like the
 * start of a tool call rather than prose?
 *
 * In agent mode the model streams its tool call token-by-token as `chunk`
 * events. The agent loop only emits `tool_start` (which clears the streamed
 * text) AFTER the whole completion finishes — so the raw JSON would flash in the
 * chat in the meantime. We suppress display of anything that looks like a tool
 * call; if it turns out to be real prose, the `onDone` fallback reveals the
 * authoritative final content, so over-suppression is self-correcting.
 *
 * Tight enough to NOT suppress legitimate answers: a language-tagged code fence
 * (```python) and markdown links ([text](url)) return false.
 */
export function looksLikeToolCall(text: string): boolean {
  const t = text.trimStart();
  if (t === '') return false;

  // Native tool-call tag (Gemma4 and similar).
  if (t.startsWith('<tool_call')) return true;

  // Fenced block: only the canonical tool formats — ``` (unlabelled), ```tool,
  // ```json. A language-tagged fence like ```python is a real answer, not a call.
  const firstLine = t.split('\n', 1)[0]!.trim();
  if (firstLine === '```' || /^```(tool|json)$/i.test(firstLine)) return true;

  // Bracket format [tool_name(… — require a word followed by '(' so markdown
  // links ([text](url)) are not caught.
  if (/^\[[a-zA-Z_]\w*\(/.test(t)) return true;

  // Bare JSON object — the most common local-model tool-call format. Any leading
  // '{' is treated as a (possibly partial) tool call; onDone reveals it if not.
  if (t.startsWith('{')) return true;

  return false;
}

/**
 * Cut a streaming answer at the first tool-call opener appearing ANYWHERE in
 * the text — not just at the start. Models often write prose ("Let me check
 * my memory graph.") and then open a tool call mid-message; `looksLikeToolCall`
 * (start-anchored) missed that, so the raw `<tool_call>{"name":…` streamed
 * into the chat. The prose before the opener stays visible; everything from
 * the opener on is suppressed. If the turn really was prose, the `onDone`
 * authoritative content restores it.
 *
 * Openers matched mid-text (conservative, to never eat real answers):
 *   - `<tool_call`               — the canonical tag, even partial
 *   - a LINE starting with `{"name"` / `{"tool"` / `{'name'` — bare JSON call
 *   - a LINE starting with ```tool or ```json — fenced call formats
 */
export function stripStreamingToolCalls(text: string): string {
  if (looksLikeToolCall(text)) return '';
  const m = /<tool_call|^\s*\{\s*["']?(?:name|tool)["']?\s*[:=]|^\s*```(?:tool|json)\s*$/im.exec(text);
  if (m) return text.slice(0, m.index).trimEnd();
  // Trailing partial opener: streaming arrives token-by-token, so the buffer
  // can end mid-tag ("… <tool_c"). Cut it so the tag never flashes; if it
  // wasn't a tool call after all, the next token reveals that and the full
  // text re-renders.
  const tail = /<[^<>]*$/.exec(text);
  if (tail && '<tool_call>'.startsWith(tail[0])) {
    return text.slice(0, tail.index).trimEnd();
  }
  return text;
}

export function splitThinking(raw: string): SplitResult {
  const thinkingParts: string[] = [];
  let answer = raw;
  let lastThinkingComplete = true;

  for (const { open, close, openLen, closeLen } of OPEN_TAGS) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const openIdx = answer.indexOf(open);
      if (openIdx === -1) break;

      // For <|channel>thought, the close tag is the next <|channel> occurrence
      // after the opening, not necessarily </think>. Skip the open tag itself.
      const searchFrom = openIdx + openLen;
      const closeIdx = answer.indexOf(close, searchFrom);

      if (closeIdx === -1) {
        // Still streaming — incomplete block
        thinkingParts.push(answer.slice(searchFrom).trim());
        answer = answer.slice(0, openIdx);
        lastThinkingComplete = false;
        break;
      }

      thinkingParts.push(answer.slice(searchFrom, closeIdx).trim());
      // For channel-based formats, keep everything from the close tag onward
      // (the close tag itself is a section marker, not a closing tag to discard fully).
      const afterClose = open === '<|channel>thought'
        ? answer.slice(closeIdx)          // keep <|channel>response etc.
        : answer.slice(closeIdx + closeLen);
      answer = answer.slice(0, openIdx) + afterClose;
    }
  }

  // Orphan close tag with no open: MiniMax-M2 / DeepSeek-R1-style chat
  // templates bake the opening <think> into the prompt, so the completion
  // arrives as "reasoning…</think>answer". Everything before the first
  // remaining close tag (paired blocks were consumed above) is reasoning.
  const orphanClose = /<\/think(?:ing)?>/i.exec(answer);
  if (orphanClose) {
    const pre = answer.slice(0, orphanClose.index).trim();
    if (pre) {
      thinkingParts.unshift(pre);
      answer = answer.slice(orphanClose.index + orphanClose[0].length);
    }
  }

  // Strip any remaining <|channel>response or <|channel>end markers from answer
  answer = answer.replace(/<\|channel>[a-z]+/g, '').trimStart();

  // Defensive: strip any un-parsed thinking tags that survived (e.g. emitted after
  // other content, Unicode lookalikes handled upstream, or partial-token edge cases).
  answer = answer.replace(/<\/?think(?:ing)?>/gi, '').trimStart();

  if (thinkingParts.length === 0) {
    return { thinking: null, answer: raw, thinkingComplete: true };
  }

  return {
    thinking: thinkingParts.filter(Boolean).join('\n\n'),
    answer: answer.trimStart(),
    thinkingComplete: lastThinkingComplete,
  };
}
