export interface SplitResult {
  thinking: string | null;
  answer: string;
  thinkingComplete: boolean;
}

export function splitThinking(raw: string): SplitResult {
  // Collect ALL <think> blocks — multiple iterations of the agentic loop each
  // emit their own thinking block, so we strip them all from the answer.
  const thinkingParts: string[] = [];
  let answer = raw;
  let lastThinkingComplete = true;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const openIdx = answer.indexOf('<think>');
    if (openIdx === -1) break;

    const closeIdx = answer.indexOf('</think>', openIdx);
    if (closeIdx === -1) {
      // Still streaming — incomplete block at the end
      thinkingParts.push(answer.slice(openIdx + 7));
      answer = answer.slice(0, openIdx);
      lastThinkingComplete = false;
      break;
    }

    thinkingParts.push(answer.slice(openIdx + 7, closeIdx));
    answer = answer.slice(0, openIdx) + answer.slice(closeIdx + 8);
  }

  if (thinkingParts.length === 0) {
    return { thinking: null, answer: raw, thinkingComplete: true };
  }

  return {
    thinking: thinkingParts.join('\n\n'),
    answer: answer.trimStart(),
    thinkingComplete: lastThinkingComplete,
  };
}
