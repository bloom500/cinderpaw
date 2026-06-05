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
