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

  if (thinkingParts.length === 0) {
    return { thinking: null, answer: raw, thinkingComplete: true };
  }

  return {
    thinking: thinkingParts.filter(Boolean).join('\n\n'),
    answer: answer.trimStart(),
    thinkingComplete: lastThinkingComplete,
  };
}
